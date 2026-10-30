# Static server for this folder on http://localhost:<Port> (Windows, no Python needed).
# Sends COOP/COEP headers so the browser enables multi-threaded WASM.
param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\') + '\'

# Models > 100 MB are stored in git as <file>.part0, .part1, ... (GitHub's file limit): join them once
$models = Join-Path $PSScriptRoot 'models'
if (Test-Path $models) {
  Get-ChildItem -Path $models -Recurse -Filter '*.part0' | ForEach-Object {
    $out = $_.FullName.Substring(0, $_.FullName.Length - '.part0'.Length)
    if ((Test-Path $out) -and (Get-Item $out).Length -gt 0) { return }
    Write-Host "Joining model $out"
    $w = [System.IO.File]::Create("$out.tmp")
    try {
      for ($i = 0; Test-Path "$out.part$i"; $i++) {
        $r = [System.IO.File]::OpenRead("$out.part$i")
        try { $r.CopyTo($w, 1048576) } finally { $r.Dispose() }
      }
    } finally { $w.Dispose() }
    Move-Item -Force "$out.tmp" $out
  }
}
$prefix = "http://localhost:$Port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch { Write-Host "Cannot start server on port $Port (already in use?)"; exit 1 }
Write-Host "Serving $root"
Write-Host "Open $prefix   (close this window to stop)"
Start-Process $prefix

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.wasm' = 'application/wasm'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $res.AddHeader('Cross-Origin-Opener-Policy', 'same-origin')
    $res.AddHeader('Cross-Origin-Embedder-Policy', 'credentialless')
    $res.AddHeader('Cache-Control', 'no-cache')
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $rel.Replace('/', '\')))
    if (-not $path.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not [System.IO.File]::Exists($path)) {
      $res.StatusCode = 404
    } else {
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      if ($mime.ContainsKey($ext)) { $res.ContentType = $mime[$ext] } else { $res.ContentType = 'application/octet-stream' }
      $fs = [System.IO.File]::OpenRead($path)
      try {
        $res.ContentLength64 = $fs.Length
        if ($req.HttpMethod -ne 'HEAD') { $fs.CopyTo($res.OutputStream, 1048576) }
      } finally { $fs.Dispose() }
    }
  } catch {
    # client aborted / disconnected - ignore
  } finally {
    try { $res.Close() } catch { }
  }
}
