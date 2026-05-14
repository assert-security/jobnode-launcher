# Launcher Protocol v1 — conformance suite (PowerShell)
#
# Exercises every protocol assertion against a deployed launcher endpoint.
# Exits 0 on success, non-zero on first failure.
#
# Usage:
#   $env:LAUNCHER_BASE_URL = "https://launcher.example.com/v1"
#   $env:LAUNCHER_TOKEN = "..."
#   $env:LAUNCHER_TENANT_SLUG = "acme-corp"
#   $env:LAUNCHER_GROUP_NAME = "ACME Internal"
#   pwsh conformance-test.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# -- configuration ----------------------------------------------------------

foreach ($v in 'LAUNCHER_BASE_URL', 'LAUNCHER_TOKEN', 'LAUNCHER_TENANT_SLUG', 'LAUNCHER_GROUP_NAME') {
    if (-not [Environment]::GetEnvironmentVariable($v)) {
        throw "$v must be set"
    }
}

$Script:BaseUrl    = [Environment]::GetEnvironmentVariable('LAUNCHER_BASE_URL').TrimEnd('/')
$Script:Token      = [Environment]::GetEnvironmentVariable('LAUNCHER_TOKEN')
$Script:TenantSlug = [Environment]::GetEnvironmentVariable('LAUNCHER_TENANT_SLUG')
$Script:GroupName  = [Environment]::GetEnvironmentVariable('LAUNCHER_GROUP_NAME')

$Script:HealthTimeoutSec  = 3
$Script:WorkersTimeoutSec = 10
$Script:LaunchTimeoutSec  = 11
$Script:DeleteTimeoutSec  = 6
$Script:ConvergeSeconds   = 30

# Workers spawned during this run, cleaned up at exit.
$Script:Spawned = New-Object 'System.Collections.Generic.List[string]'

# -- helpers ----------------------------------------------------------------

function Invoke-LauncherRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Method,
        [Parameter(Mandatory)][string] $Path,
        [object] $Body,
        [hashtable] $Headers,
        [int] $TimeoutSec = 11
    )
    $allHeaders = @{ 'Authorization' = "Bearer $Script:Token" }
    if ($Headers) { foreach ($k in $Headers.Keys) { $allHeaders[$k] = $Headers[$k] } }
    $args = @{
        Method  = $Method
        Uri     = "$Script:BaseUrl$Path"
        Headers = $allHeaders
        TimeoutSec = $TimeoutSec
        SkipHttpErrorCheck = $true
    }
    if ($null -ne $Body) {
        $args['Body'] = ($Body | ConvertTo-Json -Compress -Depth 10)
        $args['ContentType'] = 'application/json; charset=utf-8'
    }
    $resp = Invoke-WebRequest @args
    [pscustomobject]@{
        Status  = [int]$resp.StatusCode
        Body    = $resp.Content
        Headers = $resp.Headers
    }
}

function Test-Assertion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Id,
        [Parameter(Mandatory)][string] $Description,
        [Parameter(Mandatory)][scriptblock] $Test
    )
    Write-Host -NoNewline "  [$Id] $Description ... "
    try {
        $result = & $Test
        if ($result -eq $true) {
            Write-Host 'OK'
        } else {
            Write-Host 'FAIL'
            exit 1
        }
    }
    catch {
        Write-Host 'FAIL'
        Write-Host "    $($_.Exception.Message)"
        exit 1
    }
}

function Get-LauncherJson {
    [CmdletBinding()]
    param([Parameter(Mandatory)][pscustomobject] $Response)
    try {
        $Response.Body | ConvertFrom-Json
    } catch {
        throw "Response body is not valid JSON: $($Response.Body)"
    }
}

function New-RequestId { [guid]::NewGuid().ToString() }

function Invoke-Cleanup {
    if ($Script:Spawned.Count -gt 0) {
        Write-Host ""
        Write-Host "Cleaning up $($Script:Spawned.Count) spawned workers..."
        foreach ($w in $Script:Spawned) {
            try {
                Invoke-LauncherRequest -Method DELETE -Path "/workers/$w" -TimeoutSec $Script:DeleteTimeoutSec | Out-Null
            } catch {}
        }
    }
}

trap { Invoke-Cleanup }

# -- section 1: transport ---------------------------------------------------

Write-Host 'Section 1 — Transport'

Test-Assertion '1.1' 'Base URL uses HTTPS' { $Script:BaseUrl.StartsWith('https://') }

Test-Assertion '1.3' 'Content-Type and X-Protocol-Version present on /health' {
    $r = Invoke-LauncherRequest -Method GET -Path '/health' -TimeoutSec $Script:HealthTimeoutSec
    if ($r.Status -ne 200) { return $false }
    $ct = $r.Headers['Content-Type']
    if ($ct -is [array]) { $ct = $ct[0] }
    $pv = $r.Headers['X-Protocol-Version']
    if ($pv -is [array]) { $pv = $pv[0] }
    ($ct -like 'application/json*') -and ("$pv" -eq '1')
}

# -- section 2: authentication ----------------------------------------------

Write-Host 'Section 2 — Authentication'

Test-Assertion '2.1' 'No Authorization header returns 401' {
    $r = Invoke-WebRequest -Method GET -Uri "$Script:BaseUrl/health" -SkipHttpErrorCheck -TimeoutSec $Script:HealthTimeoutSec
    [int]$r.StatusCode -eq 401
}

Test-Assertion '2.2' 'Basic auth returns 401' {
    $r = Invoke-WebRequest -Method GET -Uri "$Script:BaseUrl/health" -SkipHttpErrorCheck -TimeoutSec $Script:HealthTimeoutSec -Headers @{ Authorization = 'Basic Zm9vOmJhcg==' }
    [int]$r.StatusCode -eq 401
}

Test-Assertion '2.3' 'Wrong bearer token returns 401' {
    $r = Invoke-WebRequest -Method GET -Uri "$Script:BaseUrl/health" -SkipHttpErrorCheck -TimeoutSec $Script:HealthTimeoutSec -Headers @{ Authorization = 'Bearer wrong-token-xyz' }
    [int]$r.StatusCode -eq 401
}

Test-Assertion '2.4' 'Correct bearer token accepted' {
    $r = Invoke-LauncherRequest -Method GET -Path '/health' -TimeoutSec $Script:HealthTimeoutSec
    $r.Status -eq 200
}

# -- section 3: /health -----------------------------------------------------

Write-Host 'Section 3 — GET /health'

Test-Assertion '3.x' 'Shape: status, protocolVersion=1, capabilities ⊇ {launch,list}' {
    $r = Invoke-LauncherRequest -Method GET -Path '/health' -TimeoutSec $Script:HealthTimeoutSec
    if ($r.Status -ne 200) { return $false }
    $j = Get-LauncherJson $r
    if ($j.PSObject.Properties['status'] -eq $null)          { return $false }
    if ($j.PSObject.Properties['protocolVersion'] -eq $null) { return $false }
    if ($j.PSObject.Properties['capabilities'] -eq $null)    { return $false }
    if ($j.protocolVersion -ne 1) { return $false }
    if (@('healthy','degraded','unhealthy') -notcontains $j.status) { return $false }
    ($j.capabilities -contains 'launch') -and ($j.capabilities -contains 'list')
}

# -- section 4: /workers ----------------------------------------------------

Write-Host 'Section 4 — GET /workers'

Test-Assertion '4.x' 'Shape: workers array + limits + per-worker validity' {
    $r = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
    if ($r.Status -ne 200) { return $false }
    $j = Get-LauncherJson $r
    if (-not ($j.PSObject.Properties['workers'] -and $j.PSObject.Properties['limits'])) { return $false }
    if ($j.workers -isnot [System.Collections.IEnumerable]) { return $false }
    if ($j.limits.PSObject.Properties['maxWorkers'] -eq $null) { return $false }
    if ($j.limits.PSObject.Properties['minWorkers'] -eq $null) { return $false }
    foreach ($w in @($j.workers)) {
        if ($w.workerId -notmatch '^[A-Za-z0-9_-]{1,64}$') { return $false }
        if (@('starting','running','terminating','failed') -notcontains $w.state) { return $false }
        if ($w.startedAt -notmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}T') { return $false }
    }
    $true
}

# -- section 5: /workers/launch ---------------------------------------------

Write-Host 'Section 5 — POST /workers/launch'

$Rid1 = New-RequestId
$Launch1 = @{ requestId = $Rid1; desiredCount = 1; tenantSlug = $Script:TenantSlug; groupName = $Script:GroupName }

Test-Assertion '5.1' 'desiredCount=1 returns 200 or 202' {
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $Launch1 -TimeoutSec $Script:LaunchTimeoutSec
    @(200,202) -contains $r.Status
}

Test-Assertion '5.2' 'Response echoes requestId and accepted=true' {
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $Launch1 -TimeoutSec $Script:LaunchTimeoutSec
    $j = Get-LauncherJson $r
    if ($j.PSObject.Properties['workerInstances']) {
        foreach ($wi in @($j.workerInstances)) {
            if ($wi.workerId) { $Script:Spawned.Add($wi.workerId) | Out-Null }
        }
    }
    ($j.requestId -eq $Rid1) -and ($j.accepted -eq $true)
}

Test-Assertion '5.3' 'Worker appears in GET /workers within 30s' {
    $deadline = (Get-Date).AddSeconds($Script:ConvergeSeconds)
    while ((Get-Date) -lt $deadline) {
        $r = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
        $j = Get-LauncherJson $r
        if (@($j.workers).Count -ge 1) { return $true }
        Start-Sleep -Seconds 2
    }
    $false
}

# -- section 6: idempotency -------------------------------------------------

Write-Host 'Section 6 — Idempotency'

Test-Assertion '6.1' 'Replay returns same response shape' {
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $Launch1 -TimeoutSec $Script:LaunchTimeoutSec
    if (@(200,202) -notcontains $r.Status) { return $false }
    $j = Get-LauncherJson $r
    ($j.requestId -eq $Rid1) -and ($j.accepted -eq $true)
}

Test-Assertion '6.2' 'Replay did not double-spawn' {
    $r = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
    $j = Get-LauncherJson $r
    @($j.workers).Count -eq 1
}

$Rid2 = New-RequestId
$Launch2 = @{ requestId = $Rid2; desiredCount = 2; tenantSlug = $Script:TenantSlug; groupName = $Script:GroupName }

Test-Assertion '6.3' 'New requestId with desiredCount=2 spawns a second worker' {
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $Launch2 -TimeoutSec $Script:LaunchTimeoutSec
    if (@(200,202) -notcontains $r.Status) { return $false }
    $j = Get-LauncherJson $r
    if ($j.PSObject.Properties['workerInstances']) {
        foreach ($wi in @($j.workerInstances)) {
            if ($wi.workerId) { $Script:Spawned.Add($wi.workerId) | Out-Null }
        }
    }
    $deadline = (Get-Date).AddSeconds($Script:ConvergeSeconds)
    while ((Get-Date) -lt $deadline) {
        $r2 = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
        $j2 = Get-LauncherJson $r2
        if (@($j2.workers).Count -ge 2) { return $true }
        Start-Sleep -Seconds 2
    }
    $false
}

if ($env:CONFORMANCE_LONG_TESTS -eq '1') {
    Test-Assertion '6.4' 'Dedupe window honoured for 10 minutes' {
        Write-Host ""
        Write-Host "    sleeping 600s to verify dedupe window..."
        Start-Sleep -Seconds 600
        $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $Launch1 -TimeoutSec $Script:LaunchTimeoutSec
        if (@(200,202) -notcontains $r.Status) { return $false }
        $j = Get-LauncherJson $r
        if (-not (($j.requestId -eq $Rid1) -and ($j.accepted -eq $true))) { return $false }
        $r2 = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
        $j2 = Get-LauncherJson $r2
        @($j2.workers).Count -eq 2
    }
}

# -- section 7: validation --------------------------------------------------

Write-Host 'Section 7 — Validation'

Test-Assertion '7.1' 'Non-UUID requestId returns 400' {
    $body = @{ requestId = 'not-a-uuid'; desiredCount = 1; tenantSlug = $Script:TenantSlug; groupName = $Script:GroupName }
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $body -TimeoutSec $Script:LaunchTimeoutSec
    $r.Status -eq 400
}

Test-Assertion '7.2' 'Negative desiredCount returns 400' {
    $body = @{ requestId = (New-RequestId); desiredCount = -1; tenantSlug = $Script:TenantSlug; groupName = $Script:GroupName }
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $body -TimeoutSec $Script:LaunchTimeoutSec
    $r.Status -eq 400
}

Test-Assertion '7.3' 'Missing tenantSlug returns 400' {
    $body = @{ requestId = (New-RequestId); desiredCount = 1; groupName = $Script:GroupName }
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $body -TimeoutSec $Script:LaunchTimeoutSec
    $r.Status -eq 400
}

Test-Assertion '7.4' 'Malformed workerId on DELETE returns 400' {
    $r = Invoke-LauncherRequest -Method DELETE -Path '/workers/$%@!' -TimeoutSec $Script:DeleteTimeoutSec
    $r.Status -eq 400
}

Test-Assertion '7.5' 'Wrong tenantSlug returns 403' {
    $body = @{ requestId = (New-RequestId); desiredCount = 1; tenantSlug = 'wrong-tenant'; groupName = $Script:GroupName }
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $body -TimeoutSec $Script:LaunchTimeoutSec
    $r.Status -eq 403
}

Test-Assertion '7.6' 'Wrong groupName returns 403' {
    $body = @{ requestId = (New-RequestId); desiredCount = 1; tenantSlug = $Script:TenantSlug; groupName = 'Wrong Group' }
    $r = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $body -TimeoutSec $Script:LaunchTimeoutSec
    $r.Status -eq 403
}

# -- section 8: DELETE ------------------------------------------------------

Write-Host 'Section 8 — DELETE /workers/{workerId}'

$Target = if ($Script:Spawned.Count -gt 0) { $Script:Spawned[0] } else {
    $r = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
    (Get-LauncherJson $r).workers[0].workerId
}
if (-not $Target) { Write-Host "    no worker to DELETE — failing"; exit 1 }

Test-Assertion '8.1' 'DELETE real worker returns 204' {
    $r = Invoke-LauncherRequest -Method DELETE -Path "/workers/$Target" -TimeoutSec $Script:DeleteTimeoutSec
    $r.Status -eq 204
}

Test-Assertion '8.2' 'Deleted worker disappears within 30s' {
    $deadline = (Get-Date).AddSeconds($Script:ConvergeSeconds)
    while ((Get-Date) -lt $deadline) {
        $r = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
        $j = Get-LauncherJson $r
        if (-not (@($j.workers) | Where-Object { $_.workerId -eq $Target })) { return $true }
        Start-Sleep -Seconds 2
    }
    $false
}

Test-Assertion '8.3' 'DELETE absent worker returns 204' {
    $r = Invoke-LauncherRequest -Method DELETE -Path '/workers/wkr-doesnotexist-1234' -TimeoutSec $Script:DeleteTimeoutSec
    $r.Status -eq 204
}

Test-Assertion '8.4' 'DELETE same worker twice returns 204' {
    $r = Invoke-LauncherRequest -Method DELETE -Path "/workers/$Target" -TimeoutSec $Script:DeleteTimeoutSec
    $r.Status -eq 204
}

# Remove the deleted worker from cleanup tracking
[void]$Script:Spawned.Remove($Target)

# -- section 9: capacity ----------------------------------------------------

Write-Host 'Section 9 — Capacity'

Test-Assertion '9.1' 'Over-request never exceeds maxWorkers cap' {
    $r = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
    $j = Get-LauncherJson $r
    $maxw = [int]$j.limits.maxWorkers
    $body = @{ requestId = (New-RequestId); desiredCount = ($maxw + 10); tenantSlug = $Script:TenantSlug; groupName = $Script:GroupName }
    $r2 = Invoke-LauncherRequest -Method POST -Path '/workers/launch' -Body $body -TimeoutSec $Script:LaunchTimeoutSec
    $j2 = Get-LauncherJson $r2
    if ($j2.PSObject.Properties['workerInstances']) {
        foreach ($wi in @($j2.workerInstances)) {
            if ($wi.workerId) { $Script:Spawned.Add($wi.workerId) | Out-Null }
        }
    }
    Start-Sleep -Seconds $Script:ConvergeSeconds
    $r3 = Invoke-LauncherRequest -Method GET -Path '/workers' -TimeoutSec $Script:WorkersTimeoutSec
    $j3 = Get-LauncherJson $r3
    @($j3.workers).Count -le $maxw
}

# -- done -------------------------------------------------------------------

Write-Host ""
Write-Host "All assertions passed."
Invoke-Cleanup
