//! Reads the currently-playing media from Windows' System Media Transport
//! Controls (whatever the OS is showing in its own now-playing UI). This is
//! metadata only — SMTC does not expose raw audio, so there is no real
//! spectrum/waveform data to visualize, only title/artist/playback state.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct NowPlaying {
    title: String,
    artist: String,
    playing: bool,
}

#[cfg(windows)]
#[tauri::command]
pub fn get_now_playing() -> Option<NowPlaying> {
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager, GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    unsafe {
        // Ignore the result: an "already initialized" outcome is expected
        // and harmless when called repeatedly from a thread-pool thread.
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }

    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?.get().ok()?;
    let session = manager.GetCurrentSession().ok()?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;

    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    if title.trim().is_empty() {
        return None;
    }
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();

    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|status| status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
        .unwrap_or(false);

    Some(NowPlaying { title, artist, playing })
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_now_playing() -> Option<NowPlaying> {
    None
}
