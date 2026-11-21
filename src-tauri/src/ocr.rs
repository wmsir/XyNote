//! 图片文字识别：全部用系统自带能力，离线可用。
//! - Windows 10/11：Windows.Media.Ocr（通过 Windows PowerShell 调用 WinRT）
//! - macOS 11+：Vision 框架（通过 osascript 的 JavaScript for Automation）
//! - Linux：已安装 tesseract 时使用

use base64::Engine;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

fn image_bytes(src: &str) -> Result<Vec<u8>, String> {
    let s = src.trim();
    if let Some(rest) = s.strip_prefix("data:") {
        let payload = rest.split_once(',').map(|(_, b)| b).ok_or("图片数据格式不对")?;
        return base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|_| "图片数据格式不对".to_string());
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .build();
        let resp = agent.get(s).call().map_err(|e| format!("下载图片失败：{}", e))?;
        let mut buf = Vec::new();
        resp.into_reader()
            .take(25 * 1024 * 1024)
            .read_to_end(&mut buf)
            .map_err(|e| format!("下载图片失败：{}", e))?;
        return Ok(buf);
    }
    std::fs::read(s).map_err(|_| "找不到图片文件".to_string())
}

/// 中文识别结果常常在每个汉字之间带空格，去掉汉字之间的空格
pub fn tidy_cjk_spacing(text: &str) -> String {
    let is_cjk = |c: char| {
        ('\u{4e00}'..='\u{9fff}').contains(&c)
            || ('\u{3000}'..='\u{303f}').contains(&c)
            || ('\u{ff00}'..='\u{ffef}').contains(&c)
            || ('\u{3040}'..='\u{30ff}').contains(&c)
    };
    text.lines()
        .map(|line| {
            let chars: Vec<char> = line.chars().collect();
            let mut out = String::with_capacity(line.len());
            for (i, &c) in chars.iter().enumerate() {
                if c == ' ' {
                    let prev = out.chars().last();
                    let next = chars[i + 1..].iter().find(|&&n| n != ' ').copied();
                    if let (Some(p), Some(n)) = (prev, next) {
                        if is_cjk(p) && is_cjk(n) {
                            continue;
                        }
                    }
                    if prev == Some(' ') {
                        continue;
                    }
                }
                out.push(c);
            }
            out.trim().to_string()
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_with_timeout(mut cmd: Command, stdin_data: Option<&str>, secs: u64) -> Result<String, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法启动文字识别：{}", e))?;
    if let (Some(data), Some(mut stdin)) = (stdin_data, child.stdin.take()) {
        let _ = stdin.write_all(data.as_bytes());
    }
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > Duration::from_secs(secs) => {
                let _ = child.kill();
                return Err("文字识别超时".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() && stdout.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("未知错误");
        return Err(format!("文字识别失败：{}", first.trim()));
    }
    Ok(stdout)
}

#[cfg(target_os = "windows")]
fn ocr_file(path: &Path) -> Result<String, String> {
    let p = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {{ $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }})[0]
function Await($op, $type) {{ $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('{p}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
if ($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max) {{
  $scale = [Math]::Min($max / $decoder.PixelWidth, $max / $decoder.PixelHeight)
  $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
  $tf.ScaledWidth = [uint32][Math]::Floor($decoder.PixelWidth * $scale)
  $tf.ScaledHeight = [uint32][Math]::Floor($decoder.PixelHeight * $scale)
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf, [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
}} else {{
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
}}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {{ throw '系统没有可用的文字识别语言包' }}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
$result.Lines | ForEach-Object {{ $_.Text }}
"#
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]);
    run_with_timeout(cmd, Some(&script), 60)
}

#[cfg(target_os = "macos")]
fn ocr_file(path: &Path) -> Result<String, String> {
    const JXA: &str = r#"ObjC.import('Vision');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.setRecognitionLevel(0);
  req.setUsesLanguageCorrection(true);
  try { req.setRecognitionLanguages($(['zh-Hans', 'zh-Hant', 'en-US'])); } catch (e) {}
  const ok = handler.performRequestsError($([req]), null);
  if (!ok) throw new Error('无法读取图片');
  const res = req.results;
  const out = [];
  for (let i = 0; i < res.count; i++) {
    out.push(res.objectAtIndex(i).topCandidates(1).objectAtIndex(0).string.js);
  }
  return out.join('\n');
}"#;
    let mut cmd = Command::new("osascript");
    cmd.args(["-l", "JavaScript", "-e", JXA, "--"]).arg(path);
    run_with_timeout(cmd, None, 60)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn ocr_file(path: &Path) -> Result<String, String> {
    let mut cmd = Command::new("tesseract");
    cmd.arg(path).args(["stdout", "-l", "chi_sim+eng"]);
    match run_with_timeout(cmd, None, 90) {
        Ok(s) => Ok(s),
        Err(e) if e.contains("无法启动") => {
            Err("Linux 上需要先安装 tesseract（以及中文语言包 tesseract-ocr-chi-sim）才能识别图片文字".into())
        }
        Err(e) => Err(e),
    }
}

/// 识别图片里的文字。src 可以是 data URL、http(s) 链接或本地路径。
pub fn recognize(src: &str) -> Result<String, String> {
    let bytes = image_bytes(src)?;
    if bytes.is_empty() {
        return Err("图片是空的".into());
    }
    let ext = if bytes.starts_with(&[0xFF, 0xD8]) {
        "jpg"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else {
        "png"
    };
    let path = std::env::temp_dir().join(format!(
        "xynote-ocr-{}.{}",
        uuid::Uuid::new_v4().simple(),
        ext
    ));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let res = ocr_file(&path);
    let _ = std::fs::remove_file(&path);
    let text = tidy_cjk_spacing(&res?);
    if text.trim().is_empty() {
        return Err("图片里没有识别出文字".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_spaces_between_cjk_only() {
        assert_eq!(tidy_cjk_spacing("你 好 世 界"), "你好世界");
        assert_eq!(tidy_cjk_spacing("Hello  World"), "Hello World");
        assert_eq!(tidy_cjk_spacing("版本 v2 发 布"), "版本 v2 发布");
        assert_eq!(tidy_cjk_spacing("\n  第 一 行 \n\n第 二 行"), "第一行\n第二行");
    }

    #[test]
    fn rejects_bad_data_url() {
        assert!(image_bytes("data:image/png;base64").is_err());
    }
}
