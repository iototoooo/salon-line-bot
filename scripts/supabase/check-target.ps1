<#
.SYNOPSIS
  Supabase の接続先が salon-line-bot（Project Ref: dnortggovlwgcdeoadbf）であることをローカルだけで確認する。

.DESCRIPTION
  ネットワークには接続しない。キー・パスワードの値は表示しない（表示するのはホスト名、
  キーの形式、JWT に含まれる ref / role だけ）。
  不一致が 1 つでもあれば終了コード 1 を返すので、db push の直前に実行する。

  確認する内容
    1. このスクリプトが salon-line-bot リポジトリ内にあること
    2. supabase/.temp/project-ref（supabase link の結果）が期待する Ref と一致すること（未リンクなら情報表示のみ）
    3. .env.local の SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL のホストが <Ref>.supabase.co であること
    4. .env.local のキーが取り違えられていないこと（service_role / anon、Ref の一致、NEXT_PUBLIC_ への秘密キー混入）
    5. .env.local が Git 管理外であること
    6. シェルの環境変数に SUPABASE_* / SUPABASE_YES / LINE_* が残っていないこと（.env.local より優先されるため）
    7. LINE の設定（チャネルシークレット・アクセストークンの有無と取り違え、LINE_REPLY_MODE が dry-run であること）
       値は表示しない。LINE_REPLY_MODE=live は -AllowLive を付けたときだけ OK（実送信の承認後に使う）

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\supabase\check-target.ps1
#>
param(
  [string]$ExpectedRef = 'dnortggovlwgcdeoadbf',
  [string]$EnvFile = '',
  [switch]$AllowLive
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if ($EnvFile -eq '') { $EnvFile = Join-Path $root '.env.local' }
$script:failed = $false

function Ok([string]$m)   { Write-Host "[OK]     $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "[情報]   $m" -ForegroundColor Cyan }
function Ng([string]$m)   { Write-Host "[NG]     $m" -ForegroundColor Red; $script:failed = $true }

# JWT のペイロードから ref と role だけを取り出す（署名検証はしない・値は表示しない）
function Get-JwtClaims([string]$token) {
  $parts = $token.Split('.')
  if ($parts.Length -ne 3) { return $null }
  try {
    $p = $parts[1].Replace('-', '+').Replace('_', '/')
    switch ($p.Length % 4) { 2 { $p += '==' } 3 { $p += '=' } }
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p))
    $obj = $json | ConvertFrom-Json
    return @{ ref = [string]$obj.ref; role = [string]$obj.role }
  } catch {
    return $null
  }
}

# キーの形式を判定する。expectedRole: service_role / anon
function Test-Key([string]$name, [string]$value, [string]$expectedRole) {
  if ($value -eq '') { Info "$name は未設定"; return }
  if ($value.StartsWith('eyJ')) {
    $c = Get-JwtClaims $value
    if ($null -eq $c) { Ng "$name は JWT として読み取れない"; return }
    if ($c.ref -eq $ExpectedRef) { Ok "$name の ref が一致（$($c.ref)）" } else { Ng "$name の ref が不一致（$($c.ref)）" }
    if ($c.role -eq $expectedRole) { Ok "$name の role = $($c.role)" } else { Ng "$name の role が $($c.role)（期待: $expectedRole）。キーの取り違え" }
    return
  }
  # 新形式のキー（sb_secret_ / sb_publishable_）には Ref が含まれないため、ダッシュボードで確認する
  if ($expectedRole -eq 'service_role') {
    if ($value.StartsWith('sb_secret_')) { Info "$name は新形式の secret key（Ref はキーから判定できない。ダッシュボードで確認）" }
    elseif ($value.StartsWith('sb_publishable_')) { Ng "$name に公開用（publishable）キーが入っている" }
    else { Ng "$name の形式が不明" }
  } else {
    if ($value.StartsWith('sb_publishable_')) { Info "$name は新形式の publishable key（Ref はキーから判定できない。ダッシュボードで確認）" }
    elseif ($value.StartsWith('sb_secret_')) { Ng "$name に秘密（secret）キーが入っている。ブラウザに漏れるため直ちに差し替える" }
    else { Ng "$name の形式が不明" }
  }
}

Write-Host "期待する Project Ref: $ExpectedRef"
Write-Host "リポジトリ: $root"
Write-Host ''

# 1. リポジトリの確認
$pkg = Join-Path $root 'package.json'
if ((Test-Path $pkg) -and ((Get-Content $pkg -Raw -Encoding UTF8 | ConvertFrom-Json).name -eq 'salon-line-bot')) {
  Ok 'salon-line-bot リポジトリ内で実行している'
} else {
  Ng 'salon-line-bot リポジトリではない'
}

# 2. supabase link の結果
$refFile = Join-Path $root 'supabase\.temp\project-ref'
if (Test-Path $refFile) {
  $linked = (Get-Content $refFile -Raw).Trim()
  if ($linked -eq $ExpectedRef) { Ok "supabase link 先が一致（$linked）" } else { Ng "supabase link 先が別のプロジェクト（$linked）" }
} else {
  Info '未リンク（supabase/.temp/project-ref なし）。--remote=<Ref> を明示する運用なら問題ない'
}

# 3〜5. .env.local
if (Test-Path $EnvFile) {
  $vars = @{}
  foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $v = $Matches[2].Trim()
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      $vars[$Matches[1]] = $v
    }
  }
  $expectedHost = "$ExpectedRef.supabase.co"
  foreach ($name in @('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL')) {
    $v = [string]$vars[$name]
    if ($v -eq '') { Info "$name は未設定"; continue }
    try { $h = ([Uri]$v).Host } catch { $h = '' }
    if ($h -eq $expectedHost) { Ok "$name のホストが一致（$h）" } else { Ng "$name のホストが不一致（$h）" }
  }
  Test-Key 'SUPABASE_SERVICE_ROLE_KEY' ([string]$vars['SUPABASE_SERVICE_ROLE_KEY']) 'service_role'
  Test-Key 'NEXT_PUBLIC_SUPABASE_ANON_KEY' ([string]$vars['NEXT_PUBLIC_SUPABASE_ANON_KEY']) 'anon'

  # NEXT_PUBLIC_ の値に service_role キーが入っていないか（ブラウザに配布される）
  $sr = [string]$vars['SUPABASE_SERVICE_ROLE_KEY']
  foreach ($k in $vars.Keys) {
    if (-not $k.StartsWith('NEXT_PUBLIC_')) { continue }
    $v = [string]$vars[$k]
    if ($v.StartsWith('sb_secret_') -or ($sr -ne '' -and $v -eq $sr)) { Ng "$k に秘密キーが入っている" }
    elseif ($v.StartsWith('eyJ')) {
      $c = Get-JwtClaims $v
      if ($null -ne $c -and $c.role -eq 'service_role') { Ng "$k に service_role キーが入っている" }
    }
  }
  $store = [string]$vars['WEBHOOK_EVENT_STORE']
  if ($store -eq 'supabase') { Ok 'WEBHOOK_EVENT_STORE=supabase' } else { Info "WEBHOOK_EVENT_STORE=$store（Supabase で検証するときは supabase にする）" }

  # 7. LINE の設定（値は表示しない）
  $lineSecret = [string]$vars['LINE_CHANNEL_SECRET']
  $lineToken = [string]$vars['LINE_CHANNEL_ACCESS_TOKEN']
  if ($lineSecret -eq '') { Info 'LINE_CHANNEL_SECRET は未設定（実機テストの前に設定する。未設定だと Webhook は 500 を返す）' }
  elseif ($lineSecret -match '\s') { Ng 'LINE_CHANNEL_SECRET に空白・改行が含まれている' }
  elseif ($lineSecret -match '^[0-9a-f]{32}$') { Ok 'LINE_CHANNEL_SECRET は設定済み（32 文字の 16 進数）' }
  else { Info "LINE_CHANNEL_SECRET は設定済みだが、想定（32 文字の 16 進数）と形式が異なる（長さ $($lineSecret.Length)）。コンソールの値を確認" }
  if ($lineToken -eq '') { Info 'LINE_CHANNEL_ACCESS_TOKEN は未設定（dry-run の受信テストには不要。live の返信に必要）' }
  elseif ($lineToken -match '\s') { Ng 'LINE_CHANNEL_ACCESS_TOKEN に空白・改行が含まれている' }
  elseif ($lineToken.Length -lt 100) { Info "LINE_CHANNEL_ACCESS_TOKEN は設定済みだが短い（長さ $($lineToken.Length)）。長期トークン全体を貼り付けたか確認" }
  else { Ok 'LINE_CHANNEL_ACCESS_TOKEN は設定済み' }
  if ($lineSecret -ne '' -and $lineSecret -eq $lineToken) { Ng 'LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN が同じ値（取り違え）' }
  foreach ($k in $vars.Keys) {
    if (-not $k.StartsWith('NEXT_PUBLIC_')) { continue }
    $v = [string]$vars[$k]
    if ($v -ne '' -and ($v -eq $lineSecret -or $v -eq $lineToken)) { Ng "$k に LINE の秘密情報が入っている" }
  }
  $mode = [string]$vars['LINE_REPLY_MODE']
  if ($mode -eq 'dry-run' -or $mode -eq '') { Ok "LINE_REPLY_MODE=$(if ($mode -eq '') { '（未設定 = dry-run）' } else { $mode })（LINE へは送信しない）" }
  elseif ($mode -eq 'live') {
    if ($AllowLive) { Info 'LINE_REPLY_MODE=live（実送信。-AllowLive 指定のため許可）' }
    else { Ng 'LINE_REPLY_MODE=live（実送信）になっている。承認前は dry-run に戻す（承認後は -AllowLive を付けて実行）' }
  } else { Ng "LINE_REPLY_MODE の値が不正（dry-run / live のどちらか）" }

  $full = (Resolve-Path $EnvFile).Path
  if ($full.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) {
    Push-Location $root
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $null = git check-ignore -q -- $full.Substring("$root\".Length) 2>&1
      if ($LASTEXITCODE -eq 0) { Ok "$(Split-Path $full -Leaf) は Git 管理外" } else { Ng "$(Split-Path $full -Leaf) が Git の管理対象になっている" }
    } finally { $ErrorActionPreference = $prev; Pop-Location }
  } else {
    Info '環境変数ファイルがリポジトリ外のため、Git 管理外かどうかの確認は省略'
  }
} else {
  Info ".env.local がない（$EnvFile）"
}

# 6. シェルの環境変数（値は表示しない）
$shellVars = @(Get-ChildItem env: | Where-Object { $_.Name -like 'SUPABASE_*' -or $_.Name -like 'NEXT_PUBLIC_SUPABASE_*' -or $_.Name -like 'LINE_*' -or $_.Name -eq 'WEBHOOK_EVENT_STORE' } | ForEach-Object { $_.Name })
foreach ($n in $shellVars) {
  if ($n -eq 'SUPABASE_YES') { Ng 'SUPABASE_YES が設定されている（確認なしで本番に変更が適用される）。Remove-Item env:SUPABASE_YES' }
  elseif ($n -eq 'SUPABASE_ACCESS_TOKEN' -or $n -eq 'SUPABASE_DB_PASSWORD') { Info "$n がこのシェルに設定されている（作業後に Remove-Item env:$n）" }
  else { Ng "$n がシェルに設定されている（.env.local より優先される）" }
}
if ($shellVars.Count -eq 0) { Ok 'シェルに SUPABASE_* / LINE_* / WEBHOOK_EVENT_STORE の環境変数はない' }

Write-Host ''
if ($script:failed) { Write-Host '結果: NG があります。作業を中止してください。' -ForegroundColor Red; exit 1 }
Write-Host '結果: 問題なし' -ForegroundColor Green
exit 0
