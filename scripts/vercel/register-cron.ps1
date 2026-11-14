<#
.SYNOPSIS
  定期実行（オーナー通知・定期削除）を有効にするため、CRON_SECRET と APP_BASE_URL を Vercel の Production 環境だけに登録する
  （docs/deployment.md 11 章・段階 3）。

.DESCRIPTION
  既定は dry-run（確認だけ。Vercel には何も登録しない）。-Apply を付けたときだけ登録する。再デプロイはしない。

  登録するもの
    CRON_SECRET  : Secret。このスクリプトが乱数で作る英数字 64 文字（16 進数）。画面・ファイル・クリップボードには出さない
    APP_BASE_URL : Config。https://salon-line-bot-nine.vercel.app（固定値）

  安全のための決まり
    - 値は Vercel CLI の標準入力に渡す（コマンドの引数に値を含めない）。--force（上書き）は使わない
    - CRON_SECRET・APP_BASE_URL がすでに登録されていれば、何も登録せずに停止する
    - 初回の 9 項目がそろっていない、または ANTHROPIC_API_KEY・安全スイッチが登録されている場合は停止する
      （LINE_REPLY_MODE=dry-run・自動応答 OFF・AI 未設定のまま定期実行だけを有効にするため）
    - 登録前に、リンク先（.vercel/project.json）のプロジェクト名・プロジェクト ID・チーム ID を Vercel 側と照合する
    - 登録前に、ダミーの値で標準入力の受け渡し（BOM・改行が付かないこと）を確認する
    - CRON_SECRET の元の値は保存しない。Vercel が定期実行のたびに自動で付けるため、運用では不要
      （作り直すときは、Vercel の CRON_SECRET を削除してからこのスクリプトをもう一度実行し、再デプロイする）

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vercel\register-cron.ps1           # dry-run
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\vercel\register-cron.ps1 -Apply    # 登録
#>
param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$ExpectedProjectName = 'salon-line-bot'
$AppBaseUrl = 'https://salon-line-bot-nine.vercel.app'
$VercelCliVersion = '65.15.0'
$Environment = 'production'

# 初回デプロイで登録済みであるべき 9 項目
$Required = @('LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_REPLY_MODE', 'LINE_RESPONDER', 'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WEBHOOK_EVENT_STORE')
# 今回は登録しないもの（登録されていれば停止する）
$Forbidden = @('ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'ADMIN_WRITE_MODE', 'LINE_BROADCAST_MODE', 'ADMIN_ANSWER_TEST_MODE')
# 今回登録するもの
$NewNames = @('CRON_SECRET', 'APP_BASE_URL')

function Ok([string]$m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "[情報] $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "[停止] $m" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 では子プロセスの標準入力の先頭に BOM が付くことがあるため、起動する間だけ BOM なしの UTF-8 にする
function Start-ProcessWithoutBom([System.Diagnostics.ProcessStartInfo]$Psi) {
  $saved = [Console]::InputEncoding
  try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    return [System.Diagnostics.Process]::Start($Psi)
  } finally {
    [Console]::InputEncoding = $saved
  }
}

# 標準入力で渡した値が 1 バイトも変わらずに届くかを、ダミーの値で確認する
function Test-StdinPassthrough {
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $js = Join-Path $env:TEMP ("salon-stdin-check-" + [guid]::NewGuid().ToString('N') + '.js')
  [IO.File]::WriteAllText($js, "let d=Buffer.alloc(0);process.stdin.on('data',c=>d=Buffer.concat([d,c])).on('end',()=>process.stdout.write(d.toString('hex')))", (New-Object System.Text.UTF8Encoding($false)))
  try {
    $dummy = 'dummy_' + [guid]::NewGuid().ToString('N')
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $node
    $psi.Arguments = '"' + $js + '"'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    $p = Start-ProcessWithoutBom $psi
    $o = $p.StandardOutput.ReadToEndAsync()
    $p.StandardInput.Write($dummy)
    $p.StandardInput.Close()
    $p.WaitForExit()
    $expected = -join ([System.Text.Encoding]::ASCII.GetBytes($dummy) | ForEach-Object { $_.ToString('x2') })
    return ($o.Result -eq $expected)
  } finally {
    Remove-Item $js -ErrorAction SilentlyContinue
  }
}

# Vercel CLI を実行する。標準入力は値を渡すときだけ使い、それ以外は空のまま閉じる（確認の質問には答えない）
function Invoke-Vercel([string[]]$CliArgs, [string]$StdinValue = $null) {
  $npx = (Get-Command npx.cmd -ErrorAction Stop).Source
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $npx
  $psi.Arguments = (@("vercel@$VercelCliVersion") + $CliArgs) -join ' '
  $psi.WorkingDirectory = $script:Root
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $p = Start-ProcessWithoutBom $psi
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  if ($null -ne $StdinValue) { $p.StandardInput.Write($StdinValue) }   # 改行を付けない
  $p.StandardInput.Close()
  $p.WaitForExit()
  $out = $outTask.Result
  $err = $errTask.Result
  if ($StdinValue) { $out = $out.Replace($StdinValue, '***'); $err = $err.Replace($StdinValue, '***') }
  return @{ Code = $p.ExitCode; Out = $out; Err = $err }
}

# --- 0. 場所の確認 ---------------------------------------------------------
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$projectFile = Join-Path $Root '.vercel\project.json'
$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
if ($pkg.name -ne 'salon-line-bot') { Fail 'package.json の name が salon-line-bot ではありません' }
Ok "作業フォルダ：$Root"
if ($Apply) { Info 'モード：登録（-Apply）。再デプロイはしません' } else { Info 'モード：dry-run（Vercel には何も登録しない）' }

# --- 1. 本番の URL の確認（APP_BASE_URL の取り違え防止。GET だけ） -------------
try {
  $res = Invoke-WebRequest -Uri "$AppBaseUrl/login" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20
  if ($res.StatusCode -ne 200) { Fail "$AppBaseUrl/login が 200 を返しません（$($res.StatusCode)）" }
} catch {
  Fail "$AppBaseUrl/login を開けません。本番の URL を確認してください"
}
Ok "本番の URL：$AppBaseUrl（ログイン画面が 200）"

# --- 2. 標準入力の確認・Vercel 側の確認 ---------------------------------------
if (-not (Test-StdinPassthrough)) { Fail '標準入力で値を正しく渡せません（BOM・改行が付く）。登録すると値が壊れるため停止しました' }
Ok '標準入力での値の受け渡しを確認しました（ダミーの値で、BOM・改行が付かないこと）'

if (-not (Test-Path $projectFile)) { Fail '.vercel/project.json がありません（vercel link が未実行）' }
$link = Get-Content $projectFile -Raw | ConvertFrom-Json
if ($link.projectName -ne $ExpectedProjectName) { Fail ".vercel/project.json のプロジェクト名が $ExpectedProjectName ではありません" }

$ver = Invoke-Vercel @('--version')
if ($ver.Code -ne 0) { Fail "Vercel CLI $VercelCliVersion を起動できません。先に「npx vercel@$VercelCliVersion --version」を手動で実行してください" }

$proj = Invoke-Vercel @('project', 'inspect', $ExpectedProjectName, '--json')
if ($proj.Code -ne 0) { Fail 'プロジェクト情報を取得できません（vercel whoami でログインを確認してください）' }
$pj = $proj.Out | ConvertFrom-Json
if ($pj.name -ne $ExpectedProjectName -or $pj.id -ne $link.projectId) { Fail 'Vercel 上のプロジェクトとリンク先（.vercel/project.json）のプロジェクト ID が一致しません' }
Ok "プロジェクト：$ExpectedProjectName（プロジェクト ID がリンク先と一致）"

$teams = Invoke-Vercel @('teams', 'ls', '--json')
if ($teams.Code -ne 0) { Fail 'チーム情報を取得できません' }
$team = @(($teams.Out | ConvertFrom-Json).teams) | Where-Object { $_.id -eq $link.orgId }
if (-not $team) { Fail 'リンク先のチーム ID が、ログイン中のアカウントのチームに見つかりません' }
Ok "チーム：リンク先のチーム ID と一致（プラン：$($team.plan)）"

$list = Invoke-Vercel @('env', 'ls', '--json')
if ($list.Code -ne 0) { Fail '登録済みの環境変数を取得できません' }
$existing = @(($list.Out | ConvertFrom-Json).envs)
$list = $null   # 一覧には暗号化された値が含まれるため、すぐに破棄する

$keys = @($existing | ForEach-Object { $_.key })
$missing = @($Required | Where-Object { $keys -notcontains $_ })
if ($missing.Count -gt 0) { Fail ('初回デプロイの変数がそろっていません：' + ($missing -join ', ')) }
$bad = @($Forbidden | Where-Object { $keys -contains $_ })
if ($bad.Count -gt 0) { Fail ('今回は登録されていないはずの変数があります（AI・安全スイッチ）：' + ($bad -join ', ')) }
$already = @($NewNames | Where-Object { $keys -contains $_ })
if ($already.Count -gt 0) { Fail ('すでに登録されています（上書きしないため停止）：' + ($already -join ', ')) }
$otherEnv = @($existing | Where-Object { (@($_.target) | Where-Object { $_ -ne $Environment }).Count -gt 0 })
if ($otherEnv.Count -gt 0) { Fail ('Production 以外の環境に登録されている変数があります：' + (($otherEnv | ForEach-Object { $_.key }) -join ', ')) }
Ok "登録済み：初回の 9 項目（Production のみ）。AI・安全スイッチ・CRON_SECRET・APP_BASE_URL は未登録"

# --- 3. 登録予定の表示 ---------------------------------------------------------
Write-Host ''
Write-Host ('{0,-14} {1,-7} {2,-11} {3}' -f '変数名', '種類', '登録先', '値')
Write-Host ('{0,-14} {1,-7} {2,-11} {3}' -f 'CRON_SECRET', 'Secret', 'Production', '登録時に乱数で作る英数字 64 文字（表示・保存しない）')
Write-Host ('{0,-14} {1,-7} {2,-11} {3}' -f 'APP_BASE_URL', 'Config', 'Production', $AppBaseUrl)
Write-Host ''
Info '登録後に再デプロイすると、定期通知（15 分ごと）と定期削除（毎日 03:17 JST ごろ）が動き始めます'

if (-not $Apply) {
  Ok 'dry-run 完了。登録予定 2 項目（Vercel には何も登録していません）'
  exit 0
}

# --- 4. 登録（-Apply のときだけ） ---------------------------------------------
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
[Array]::Clear($bytes, 0, $bytes.Length)
if ($secret -notmatch '^[0-9a-f]{64}$') { Fail 'CRON_SECRET を作れませんでした' }

$r = Invoke-Vercel @('env', 'add', 'CRON_SECRET', '--environment', $Environment, '--type', 'secret') $secret
$secret = $null
if ($r.Code -ne 0) { Write-Host ($r.Err.Trim()) -ForegroundColor Red; Fail 'CRON_SECRET の登録に失敗しました（何も登録されていません）' }
Ok 'CRON_SECRET を登録しました（Secret）'

$r = Invoke-Vercel @('env', 'add', 'APP_BASE_URL', '--environment', $Environment, '--type', 'config') $AppBaseUrl
if ($r.Code -ne 0) { Write-Host ($r.Err.Trim()) -ForegroundColor Red; Fail 'APP_BASE_URL の登録に失敗しました（CRON_SECRET は登録済み）' }
Ok 'APP_BASE_URL を登録しました（Config）'

# --- 5. 登録後の確認（変数名・種類・登録先だけ） ------------------------------
$after = Invoke-Vercel @('env', 'ls', '--json')
if ($after.Code -ne 0) { Fail '登録後の一覧を取得できません。vercel env ls production で確認してください' }
$envs = @(($after.Out | ConvertFrom-Json).envs)
$after = $null
Write-Host ''
Write-Host '登録後の環境変数（値は表示しない）'
foreach ($e in ($envs | Sort-Object key)) { Write-Host ('  {0,-31} 種類={1,-10} 登録先={2}' -f $e.key, $e.type, (@($e.target) -join ',')) }
$names = @($envs | ForEach-Object { $_.key })
if (@($Required + $NewNames | Where-Object { $names -notcontains $_ }).Count -gt 0 -or $envs.Count -ne 11) { Fail '登録後の環境変数が 11 項目になっていません' }
Ok '11 項目が Production に登録されています。次は再デプロイです（docs/deployment.md 11 章）'
