<#
.SYNOPSIS
  初回デプロイ用の環境変数 9 項目を、Vercel の Production 環境だけに登録する（docs/deployment.md 9.3）。

.DESCRIPTION
  既定は dry-run（確認だけ。Vercel には何も登録しない）。-Apply を付けたときだけ登録する。

  安全のための決まり
    - 値は画面・ログ・コマンド履歴に出さない。.env.local は読み取るだけで変更しない
    - 値は Vercel CLI の標準入力に渡す（コマンドの引数に値を含めない。--value は使わない）
    - 登録先は Production だけ。--force（上書き）は使わない。登録済みの変数はそのままにする
    - 登録するのは下の 9 項目だけ。CRON_SECRET・ANTHROPIC_API_KEY・安全スイッチ類は登録しない
    - 安全に関わる値（LINE_REPLY_MODE=dry-run・LINE_RESPONDER=ai・WEBHOOK_EVENT_STORE=supabase・
      Supabase の URL）は .env.local ではなく、このスクリプトの固定値を使う
    - 1 つでも不足・空・形式違いがあれば、何も登録せずに停止する
    - 登録前に、リンク先（.vercel/project.json）のプロジェクト名・プロジェクト ID・チーム ID を Vercel 側と照合する
    - vercel env pull は実行しない

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\vercel\register-env.ps1           # dry-run
  powershell -ExecutionPolicy Bypass -File scripts\vercel\register-env.ps1 -Apply    # 登録
#>
param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$ExpectedProjectName = 'salon-line-bot'
$SupabaseUrl = 'https://dnortggovlwgcdeoadbf.supabase.co'
$VercelCliVersion = '65.15.0'
$Environment = 'production'

# 登録する 9 項目（この表にないものは登録しない）
#   Source: local = .env.local の値 / fixed = このスクリプトの固定値
$Targets = @(
  @{ Name = 'LINE_CHANNEL_SECRET';           Type = 'secret'; Source = 'local'; Pattern = '^[0-9a-fA-F]{32}$';              Hint = '16 進数 32 文字' },
  @{ Name = 'LINE_CHANNEL_ACCESS_TOKEN';     Type = 'secret'; Source = 'local'; Pattern = '^[A-Za-z0-9+/=]{100,}$';         Hint = '英数字と + / = の 100 文字以上' },
  @{ Name = 'LINE_REPLY_MODE';               Type = 'config'; Source = 'fixed'; Value = 'dry-run' },
  @{ Name = 'LINE_RESPONDER';                Type = 'config'; Source = 'fixed'; Value = 'ai' },
  @{ Name = 'NEXT_PUBLIC_SUPABASE_URL';      Type = 'config'; Source = 'fixed'; Value = $SupabaseUrl },
  @{ Name = 'NEXT_PUBLIC_SUPABASE_ANON_KEY'; Type = 'config'; Source = 'local'; Pattern = '^sb_publishable_[A-Za-z0-9_-]{10,}$'; Hint = 'sb_publishable_ で始まる publishable key' },
  @{ Name = 'SUPABASE_URL';                  Type = 'config'; Source = 'fixed'; Value = $SupabaseUrl },
  @{ Name = 'SUPABASE_SERVICE_ROLE_KEY';     Type = 'secret'; Source = 'local'; Pattern = '^sb_secret_[A-Za-z0-9_-]{10,}$';     Hint = 'sb_secret_ で始まる secret key' },
  @{ Name = 'WEBHOOK_EVENT_STORE';           Type = 'config'; Source = 'fixed'; Value = 'supabase' }
)

# 絶対に登録しないもの（Vercel 側にあれば警告する）
$Forbidden = @('CRON_SECRET', 'ANTHROPIC_API_KEY', 'CLAUDE_MODEL', 'ADMIN_WRITE_MODE', 'LINE_BROADCAST_MODE', 'ADMIN_ANSWER_TEST_MODE', 'APP_BASE_URL')

function Ok([string]$m)   { Write-Host "[OK]   $m" -ForegroundColor Green }
function Info([string]$m) { Write-Host "[情報] $m" -ForegroundColor Cyan }
function Fail([string]$m) { Write-Host "[停止] $m" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 では、コンソールの入力の文字コードが UTF-8（BOM 付き）のとき、子プロセスの標準入力の先頭に
# BOM（3 バイト）が付き、登録する値が壊れる。起動する間だけ BOM なしの UTF-8 にする（2026-11-13 に確認）
function Start-ProcessWithoutBom([System.Diagnostics.ProcessStartInfo]$Psi) {
  $saved = [Console]::InputEncoding
  try {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    return [System.Diagnostics.Process]::Start($Psi)
  } finally {
    [Console]::InputEncoding = $saved
  }
}

# 標準入力で渡した値が、1 バイトも変わらずに子プロセスへ届くかを確認する（ダミーの値を使う。実際の値は使わない）
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
  # 念のため、出力に値が含まれていたら伏せる
  if ($StdinValue) { $out = $out.Replace($StdinValue, '***'); $err = $err.Replace($StdinValue, '***') }
  return @{ Code = $p.ExitCode; Out = $out; Err = $err }
}

# --- 0. 場所の確認 ---------------------------------------------------------
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envFile = Join-Path $Root '.env.local'
$projectFile = Join-Path $Root '.vercel\project.json'
if (-not (Test-Path (Join-Path $Root 'package.json'))) { Fail 'リポジトリのルートが見つかりません' }
$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
if ($pkg.name -ne 'salon-line-bot') { Fail "package.json の name が salon-line-bot ではありません" }
Ok "作業フォルダ：$Root"
if ($Apply) { Info 'モード：登録（-Apply）' } else { Info 'モード：dry-run（Vercel には何も登録しない）' }

# --- 1. .env.local の読み取り（変更しない・値は表示しない） -----------------
if (-not (Test-Path $envFile)) { Fail '.env.local がありません' }
$local = @{}
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $i = $line.IndexOf('=')
  $k = $line.Substring(0, $i).Trim()
  $v = $line.Substring($i + 1)
  if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
  $local[$k] = $v
}
Ok ".env.local を読み取りました（変数 $($local.Count) 個。値は表示しません）"

# .env.local の URL が対象プロジェクトと違う場合は止める（取り違え防止）
foreach ($k in @('NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL')) {
  if ($local.ContainsKey($k) -and $local[$k].Trim() -ne '' -and $local[$k].Trim().TrimEnd('/') -ne $SupabaseUrl) {
    Fail ".env.local の $k が対象の Supabase プロジェクトと一致しません"
  }
}

# --- 2. 値の準備と検証（1 つでも NG なら何も登録しない） -------------------
$values = @{}
$problems = @()
foreach ($t in $Targets) {
  if ($t.Source -eq 'fixed') { $values[$t.Name] = $t.Value; continue }
  if (-not $local.ContainsKey($t.Name)) { $problems += "$($t.Name)：.env.local にありません"; continue }
  $v = $local[$t.Name]
  if ($v -eq '') { $problems += "$($t.Name)：値が空です"; continue }
  if ($v -ne $v.Trim()) { $problems += "$($t.Name)：前後に空白があります"; continue }
  if ($v -notmatch $t.Pattern) { $problems += "$($t.Name)：形式が違います（期待：$($t.Hint)）"; continue }
  $values[$t.Name] = $v
}
# 取り違えの確認：公開用の変数に secret key、サーバー用の変数に publishable key が入っていないか
if ($values['NEXT_PUBLIC_SUPABASE_ANON_KEY'] -and $values['NEXT_PUBLIC_SUPABASE_ANON_KEY'] -like 'sb_secret_*') { $problems += 'NEXT_PUBLIC_SUPABASE_ANON_KEY：secret key が入っています' }
if ($values['SUPABASE_SERVICE_ROLE_KEY'] -and $values['SUPABASE_SERVICE_ROLE_KEY'] -eq $values['NEXT_PUBLIC_SUPABASE_ANON_KEY']) { $problems += 'SUPABASE_SERVICE_ROLE_KEY：publishable key と同じ値です' }
foreach ($t in $Targets) {
  if ($Forbidden -contains $t.Name) { $problems += "$($t.Name)：登録してはいけない変数が対象に含まれています" }
}
if ($problems.Count -gt 0) {
  foreach ($p in $problems) { Write-Host "[NG]   $p" -ForegroundColor Red }
  Fail '値に問題があるため、何も登録せずに停止しました'
}
Ok '9 項目の値を検証しました（不足・空・形式違いなし）'

# --- 3. Vercel 側の確認（プロジェクト・チーム・登録済みの変数） -------------
if (-not (Test-Path $projectFile)) { Fail '.vercel/project.json がありません（vercel link が未実行）' }
$link = Get-Content $projectFile -Raw | ConvertFrom-Json
if ($link.projectName -ne $ExpectedProjectName) { Fail ".vercel/project.json のプロジェクト名が $ExpectedProjectName ではありません" }

if (-not (Test-StdinPassthrough)) { Fail '標準入力で値を正しく渡せません（BOM・改行が付く）。登録すると値が壊れるため停止しました' }
Ok '標準入力での値の受け渡しを確認しました（ダミーの値で、BOM・改行が付かないこと）'

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
$list = $null   # 一覧には Config の値が含まれるため、すぐに破棄する

# 登録してはいけない変数・Production 以外への登録がないか
$bad = @($existing | Where-Object { $Forbidden -contains $_.key })
foreach ($b in $bad) { Write-Host "[警告] Vercel に登録してはいけない変数があります：$($b.key)" -ForegroundColor Yellow }
$targetNames = $Targets | ForEach-Object { $_.Name }
$otherEnv = @($existing | Where-Object { $targetNames -contains $_.key -and (@($_.target) | Where-Object { $_ -ne $Environment }).Count -gt 0 })
if ($otherEnv.Count -gt 0) { Fail ("Production 以外の環境にも登録されている変数があります：" + (($otherEnv | ForEach-Object { $_.key }) -join ', ')) }

# --- 4. 一覧の表示（値は表示しない） -----------------------------------------
Write-Host ''
Write-Host ('{0,-31} {1,-7} {2,-11} {3,-14} {4}' -f '変数名', '種類', '登録先', '値の出どころ', 'Vercel の状態')
$toAdd = @()
foreach ($t in $Targets) {
  $already = @($existing | Where-Object { $_.key -eq $t.Name -and (@($_.target) -contains $Environment) }).Count -gt 0
  $kind = if ($t.Type -eq 'secret') { 'Secret' } else { 'Config' }
  $src = if ($t.Source -eq 'fixed') { "固定値" } else { '.env.local' }
  $state = if ($already) { '登録済み（変更しない）' } else { '未登録 → 登録' }
  Write-Host ('{0,-31} {1,-7} {2,-11} {3,-14} {4}' -f $t.Name, $kind, 'Production', $src, $state)
  if (-not $already) { $toAdd += $t }
}
Write-Host ''
Info ('固定値：LINE_REPLY_MODE=dry-run / LINE_RESPONDER=ai / WEBHOOK_EVENT_STORE=supabase / Supabase の URL は ' + $SupabaseUrl)
Info ('登録しない：' + ($Forbidden -join ', '))

if (-not $Apply) {
  Ok "dry-run 完了。登録予定 $($toAdd.Count) 項目（Vercel には何も登録していません）"
  exit 0
}

# --- 5. 登録（-Apply のときだけ） ---------------------------------------------
foreach ($t in $toAdd) {
  $r = Invoke-Vercel @('env', 'add', $t.Name, '--environment', $Environment, '--type', $t.Type) $values[$t.Name]
  if ($r.Code -ne 0) {
    Write-Host ($r.Err.Trim()) -ForegroundColor Red
    Fail "$($t.Name) の登録に失敗しました。ここで停止します（それまでに登録した変数はそのまま）"
  }
  Ok "$($t.Name) を登録しました（$($t.Type)）"
}
$values = $null

# --- 6. 登録後の確認（変数名・種類・登録先だけ） ------------------------------
$after = Invoke-Vercel @('env', 'ls', '--environment', $Environment, '--json')
if ($after.Code -ne 0) { Fail '登録後の一覧を取得できません。vercel env ls production で確認してください' }
$envs = @(($after.Out | ConvertFrom-Json).envs)
$after = $null
Write-Host ''
Write-Host '登録後の Production の環境変数（値は表示しない）'
foreach ($e in ($envs | Sort-Object key)) { Write-Host ('  {0,-31} 種類={1,-10} 登録先={2}' -f $e.key, $e.type, (@($e.target) -join ',')) }
$missing = @($targetNames | Where-Object { $n = $_; -not ($envs | Where-Object { $_.key -eq $n }) })
if ($missing.Count -gt 0) { Fail ('登録されていない変数があります：' + ($missing -join ', ')) }
Ok '9 項目が Production に登録されています'
