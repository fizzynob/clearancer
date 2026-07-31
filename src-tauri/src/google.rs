use crate::storage;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

const SCOPES: &str = "https://www.googleapis.com/auth/classroom.courses.readonly \
https://www.googleapis.com/auth/classroom.coursework.me.readonly \
https://www.googleapis.com/auth/classroom.student-submissions.me.readonly \
https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly \
https://www.googleapis.com/auth/classroom.announcements.readonly \
https://www.googleapis.com/auth/userinfo.email";

fn auth_file_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    storage::app_file_path(app, "google_auth.json")
}

/// GETs a Classroom endpoint, retrying with backoff on 429 (rate limited) or
/// transient 5xx responses instead of failing the whole sync outright.
async fn get_with_retry(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<reqwest::Response, String> {
    let mut delay = Duration::from_millis(800);
    const MAX_ATTEMPTS: u32 = 4;

    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("request to Google failed: {e}"))?;

        let status = resp.status();
        let retryable = status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
        if retryable && attempt < MAX_ATTEMPTS {
            let wait = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(delay);
            tokio::time::sleep(wait).await;
            delay *= 2;
            continue;
        }
        return Ok(resp);
    }
    unreachable!("loop always returns before exhausting MAX_ATTEMPTS")
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct GoogleAuthState {
    client_id: String,
    client_secret: String,
    refresh_token: Option<String>,
    access_token: Option<String>,
    expires_at: Option<u64>,
    email: Option<String>,
}

fn load_state(app: &AppHandle) -> GoogleAuthState {
    let path = match auth_file_path(app) {
        Ok(p) => p,
        Err(_) => return GoogleAuthState::default(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(app: &AppHandle, state: &GoogleAuthState) -> Result<(), String> {
    let path = auth_file_path(app)?;
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    storage::atomic_write(&path, &json)
}

fn now_epoch() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

/* ------------------------------- status --------------------------------- */

#[derive(Serialize)]
pub struct GoogleStatus {
    connected: bool,
    email: Option<String>,
}

#[tauri::command]
pub fn google_status(app: AppHandle) -> GoogleStatus {
    let state = load_state(&app);
    GoogleStatus { connected: state.refresh_token.is_some(), email: state.email }
}

#[tauri::command]
pub fn google_disconnect(app: AppHandle) -> Result<(), String> {
    let path = auth_file_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ------------------------------ oauth flow ------------------------------- */

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
}

#[derive(Serialize)]
pub struct BeginAuthResult {
    #[serde(rename = "authUrl")]
    auth_url: String,
}

/// Starts the loopback OAuth flow: opens a local listener on a free port,
/// hands the frontend a Google consent URL to open in the system browser,
/// then finishes the exchange in the background and emits
/// `google-auth-complete` with `{ ok, email? , error? }` when done.
#[tauri::command]
pub async fn google_begin_auth(
    app: AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<BeginAuthResult, String> {
    let mut state = load_state(&app);
    state.client_id = client_id.clone();
    state.client_secret = client_secret.clone();
    save_state(&app, &state)?;

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("could not open a local port for sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect_uri),
        urlencoding::encode(SCOPES),
    );

    tauri::async_runtime::spawn(async move {
        let outcome = complete_auth_flow(listener, redirect_uri, client_id, client_secret).await;
        let payload = match outcome {
            Ok(tokens) => {
                let mut state = load_state(&app);
                state.access_token = Some(tokens.access_token.clone());
                if tokens.refresh_token.is_some() {
                    state.refresh_token = tokens.refresh_token;
                }
                state.expires_at = Some(now_epoch() + tokens.expires_in.saturating_sub(30));
                state.email = fetch_email(&tokens.access_token).await.ok().or(state.email);
                let email = state.email.clone();
                match save_state(&app, &state) {
                    Ok(()) => serde_json::json!({ "ok": true, "email": email }),
                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                }
            }
            Err(e) => serde_json::json!({ "ok": false, "error": e }),
        };
        let _ = app.emit("google-auth-complete", payload);
    });

    Ok(BeginAuthResult { auth_url })
}

async fn complete_auth_flow(
    listener: TcpListener,
    redirect_uri: String,
    client_id: String,
    client_secret: String,
) -> Result<TokenResponse, String> {
    let deadline = Instant::now() + AUTH_TIMEOUT;
    let code = tokio::task::spawn_blocking(move || accept_one_request(listener, deadline))
        .await
        .map_err(|e| e.to_string())??;

    exchange_code(&client_id, &client_secret, &code, &redirect_uri).await
}

/// Blocks (off the async runtime) until Google redirects back to our
/// loopback listener with `?code=...`, or the deadline passes.
fn accept_one_request(listener: TcpListener, deadline: Instant) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        match listener.accept() {
            Ok((stream, _)) => return handle_redirect(stream),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("Timed out waiting for Google sign-in.".to_string());
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn handle_redirect(mut stream: TcpStream) -> Result<String, String> {
    stream.set_nonblocking(false).ok();
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let first_line = request.lines().next().unwrap_or("");
    let path = first_line.split_whitespace().nth(1).unwrap_or("/");
    let query = path.splitn(2, '?').nth(1).unwrap_or("");

    let params: HashMap<String, String> = query
        .split('&')
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let key = it.next()?;
            let value = it.next().unwrap_or("");
            Some((key.to_string(), urlencoding::decode(value).ok()?.into_owned()))
        })
        .collect();

    let code = params.get("code").cloned();
    let body = if code.is_some() {
        "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:80px;\">\
         <h2>Clearancer is connected.</h2><p>You can close this window and return to the app.</p>\
         </body></html>"
    } else {
        "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:80px;\">\
         <h2>Sign-in was not completed.</h2><p>You can close this window and return to Clearancer.</p>\
         </body></html>"
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    match code {
        Some(c) => Ok(c),
        None => match params.get("error") {
            Some(err) => Err(format!("Google sign-in was cancelled or denied ({err}).")),
            None => Err("Malformed redirect from Google.".to_string()),
        },
    }
}

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Google rejected the sign-in: {text}"));
    }
    resp.json::<TokenResponse>().await.map_err(|e| format!("could not parse token response: {e}"))
}

async fn fetch_email(access_token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct UserInfo {
        email: Option<String>,
    }
    let client = reqwest::Client::new();
    let resp = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let info: UserInfo = resp.json().await.map_err(|e| e.to_string())?;
    info.email.ok_or_else(|| "no email in userinfo response".to_string())
}

/// Ensures we have a non-expired access token, refreshing it via the stored
/// refresh token if needed, and returns it.
async fn ensure_access_token(app: &AppHandle) -> Result<String, String> {
    let mut state = load_state(app);
    let refresh_token = state
        .refresh_token
        .clone()
        .ok_or_else(|| "Not connected to Google Classroom yet.".to_string())?;

    let needs_refresh = match (&state.access_token, state.expires_at) {
        (Some(_), Some(exp)) => now_epoch() >= exp,
        _ => true,
    };
    if !needs_refresh {
        return Ok(state.access_token.clone().unwrap());
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", state.client_id.as_str()),
            ("client_secret", state.client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Google rejected the refresh request: {text}"));
    }
    let token: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    state.access_token = Some(token.access_token.clone());
    state.expires_at = Some(now_epoch() + token.expires_in.saturating_sub(30));
    save_state(app, &state)?;
    Ok(token.access_token)
}

/* ----------------------------- classroom api ----------------------------- */

#[derive(Serialize)]
pub struct CourseSummary {
    id: String,
    name: String,
}

#[derive(Deserialize, Default)]
struct CoursesResponse {
    #[serde(default)]
    courses: Vec<CourseRaw>,
}
#[derive(Deserialize)]
struct CourseRaw {
    id: String,
    name: String,
}

#[tauri::command]
pub async fn google_list_courses(app: AppHandle) -> Result<Vec<CourseSummary>, String> {
    let token = ensure_access_token(&app).await?;
    let client = reqwest::Client::new();
    let resp = get_with_retry(
        &client,
        "https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&studentId=me",
        &token,
    )
    .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Classroom API error: {text}"));
    }
    let parsed: CoursesResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parsed.courses.into_iter().map(|c| CourseSummary { id: c.id, name: c.name }).collect())
}

#[derive(Serialize)]
pub struct SyncedItem {
    #[serde(rename = "sourceId")]
    source_id: String,
    title: String,
    #[serde(rename = "maxPoints")]
    max_points: f64,
    #[serde(rename = "assignedGrade")]
    assigned_grade: Option<f64>,
    state: String,
    #[serde(rename = "dueDate")]
    due_date: Option<String>,
    updated: Option<String>,
}

#[derive(Deserialize, Default)]
struct CourseWorkListResponse {
    #[serde(rename = "courseWork", default)]
    course_work: Vec<CourseWorkRaw>,
}
#[derive(Deserialize)]
struct CourseWorkRaw {
    id: String,
    title: String,
    #[serde(rename = "maxPoints", default)]
    max_points: Option<f64>,
    #[serde(rename = "dueDate", default)]
    due_date: Option<DueDate>,
    #[serde(rename = "updateTime", default)]
    update_time: Option<String>,
}
#[derive(Deserialize)]
struct DueDate {
    year: i32,
    month: u32,
    day: u32,
}

#[derive(Deserialize, Default)]
struct SubmissionsResponse {
    #[serde(rename = "studentSubmissions", default)]
    student_submissions: Vec<SubmissionRaw>,
}
#[derive(Deserialize)]
struct SubmissionRaw {
    #[serde(rename = "courseWorkId")]
    course_work_id: String,
    state: String,
    #[serde(rename = "assignedGrade", default)]
    assigned_grade: Option<f64>,
}

// Classroom keeps ungraded "Material" posts (readings, links, files with no
// due date or submissions) in a separate resource from coursework.
#[derive(Deserialize, Default)]
struct CourseWorkMaterialsResponse {
    #[serde(rename = "courseWorkMaterial", default)]
    course_work_material: Vec<CourseWorkMaterialRaw>,
}
#[derive(Deserialize)]
struct CourseWorkMaterialRaw {
    id: String,
    #[serde(default)]
    materials: Vec<MaterialWrapper>,
    #[serde(rename = "updateTime", default)]
    update_time: Option<String>,
}

// Teachers sometimes attach files to a plain announcement instead of using a
// proper Material post — those need scanning too.
#[derive(Deserialize, Default)]
struct AnnouncementsResponse {
    #[serde(default)]
    announcements: Vec<AnnouncementRaw>,
}
#[derive(Deserialize)]
struct AnnouncementRaw {
    id: String,
    #[serde(default)]
    materials: Vec<MaterialWrapper>,
    #[serde(rename = "updateTime", default)]
    update_time: Option<String>,
}

// A Classroom "Material" attachment is a tagged union: exactly one of these
// is populated depending on what was attached (Drive file, YouTube video,
// link, or Google Form). We only care about its display name/file name —
// per-post titles are intentionally never used for materials or
// announcements, only the individual attached file names.
#[derive(Deserialize, Default)]
struct MaterialWrapper {
    #[serde(rename = "driveFile", default)]
    drive_file: Option<SharedDriveFile>,
    #[serde(rename = "youTubeVideo", default)]
    you_tube_video: Option<TitledMaterial>,
    #[serde(default)]
    link: Option<TitledMaterial>,
    #[serde(default)]
    form: Option<TitledMaterial>,
}
#[derive(Deserialize)]
struct SharedDriveFile {
    #[serde(rename = "driveFile", default)]
    drive_file: Option<TitledMaterial>,
}
#[derive(Deserialize)]
struct TitledMaterial {
    #[serde(default)]
    title: Option<String>,
}

impl MaterialWrapper {
    fn file_name(&self) -> Option<String> {
        self.drive_file
            .as_ref()
            .and_then(|d| d.drive_file.as_ref())
            .and_then(|f| f.title.clone())
            .or_else(|| self.you_tube_video.as_ref().and_then(|v| v.title.clone()))
            .or_else(|| self.link.as_ref().and_then(|l| l.title.clone()))
            .or_else(|| self.form.as_ref().and_then(|f| f.title.clone()))
    }
}

/// Turns a Material/Announcement post's attachments into one SyncedItem per
/// attached file, named after the file itself. Posts with no attachments
/// (or attachments without a readable name) contribute nothing — per-post
/// titles are never used as a fallback here.
fn materials_to_items(base_id: &str, materials: &[MaterialWrapper], updated: Option<String>) -> Vec<SyncedItem> {
    materials
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let title = m.file_name()?;
            Some(SyncedItem {
                source_id: format!("{base_id}#{i}"),
                title,
                max_points: 0.0,
                assigned_grade: None,
                state: "MATERIAL".to_string(),
                due_date: None,
                updated: updated.clone(),
            })
        })
        .collect()
}

/// Fetches all coursework and materials for a course, plus the signed-in
/// student's submissions/grades for the coursework, and returns one
/// normalized item per coursework/material entry. The frontend upserts these
/// into its own store.
#[tauri::command]
pub async fn google_sync_course(app: AppHandle, course_id: String) -> Result<Vec<SyncedItem>, String> {
    let token = ensure_access_token(&app).await?;
    let client = reqwest::Client::new();

    let cw_resp = get_with_retry(
        &client,
        &format!("https://classroom.googleapis.com/v1/courses/{course_id}/courseWork"),
        &token,
    )
    .await?;
    if !cw_resp.status().is_success() {
        let text = cw_resp.text().await.unwrap_or_default();
        return Err(format!("Classroom API error (coursework): {text}"));
    }
    let cw: CourseWorkListResponse = cw_resp.json().await.map_err(|e| e.to_string())?;

    let sub_resp = get_with_retry(
        &client,
        &format!(
            "https://classroom.googleapis.com/v1/courses/{course_id}/courseWork/-/studentSubmissions?userId=me"
        ),
        &token,
    )
    .await?;
    let submissions: SubmissionsResponse = if sub_resp.status().is_success() {
        sub_resp.json().await.unwrap_or_default()
    } else {
        let status = sub_resp.status();
        let text = sub_resp.text().await.unwrap_or_default();
        eprintln!("Classroom API warning (submissions, course {course_id}): {status}: {text}");
        SubmissionsResponse::default()
    };

    let material_resp = get_with_retry(
        &client,
        &format!("https://classroom.googleapis.com/v1/courses/{course_id}/courseWorkMaterials"),
        &token,
    )
    .await?;
    let materials: CourseWorkMaterialsResponse = if material_resp.status().is_success() {
        material_resp.json().await.unwrap_or_default()
    } else {
        // Non-fatal: don't let a materials-only failure (e.g. a missing scope
        // after a token predates a permission change) kill the whole sync,
        // but do surface it in the logs instead of silently reporting zero.
        let status = material_resp.status();
        let text = material_resp.text().await.unwrap_or_default();
        eprintln!("Classroom API warning (materials, course {course_id}): {status}: {text}");
        CourseWorkMaterialsResponse::default()
    };

    let ann_resp = get_with_retry(
        &client,
        &format!("https://classroom.googleapis.com/v1/courses/{course_id}/announcements"),
        &token,
    )
    .await?;
    let announcements: AnnouncementsResponse = if ann_resp.status().is_success() {
        ann_resp.json().await.unwrap_or_default()
    } else {
        let status = ann_resp.status();
        let text = ann_resp.text().await.unwrap_or_default();
        eprintln!("Classroom API warning (announcements, course {course_id}): {status}: {text}");
        AnnouncementsResponse::default()
    };

    let mut by_coursework: HashMap<String, &SubmissionRaw> = HashMap::new();
    for s in &submissions.student_submissions {
        by_coursework.insert(s.course_work_id.clone(), s);
    }

    let coursework_items: Vec<SyncedItem> = cw
        .course_work
        .into_iter()
        .map(|c| {
            let submission = by_coursework.get(&c.id);
            SyncedItem {
                state: submission.map(|s| s.state.clone()).unwrap_or_else(|| "CREATED".to_string()),
                assigned_grade: submission.and_then(|s| s.assigned_grade),
                due_date: c.due_date.map(|d| format!("{:04}-{:02}-{:02}", d.year, d.month, d.day)),
                updated: c.update_time.map(|t| t.chars().take(10).collect::<String>()),
                source_id: c.id,
                title: c.title,
                max_points: c.max_points.unwrap_or(0.0),
            }
        })
        .collect();

    // Materials and announcements are named after their attached files, not
    // the post itself — a single post with three attachments becomes three
    // separate items, and posts with no attachments contribute nothing.
    let material_items: Vec<SyncedItem> = materials
        .course_work_material
        .iter()
        .flat_map(|m| {
            let updated = m.update_time.as_ref().map(|t| t.chars().take(10).collect::<String>());
            materials_to_items(&m.id, &m.materials, updated)
        })
        .collect();

    let announcement_items: Vec<SyncedItem> = announcements
        .announcements
        .iter()
        .flat_map(|a| {
            let updated = a.update_time.as_ref().map(|t| t.chars().take(10).collect::<String>());
            materials_to_items(&a.id, &a.materials, updated)
        })
        .collect();

    Ok(coursework_items
        .into_iter()
        .chain(material_items)
        .chain(announcement_items)
        .collect())
}
