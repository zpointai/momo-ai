param([Parameter(Mandatory=$true)][int]$RootProcessId,[Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$known=[Collections.Generic.HashSet[int]]::new();[void]$known.Add($RootProcessId)
$records=[Collections.Generic.List[object]]::new();$seen=[Collections.Generic.HashSet[string]]::new()
$processes=[Collections.Generic.List[object]]::new();$samples=0;$started=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Set-Content -LiteralPath (Join-Path $OutputDirectory 'observer-ready') -Value 'ready'
while(!(Test-Path -LiteralPath (Join-Path $OutputDirectory 'observer-stop')) -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$started)-lt240000) {
 $all=Get-CimInstance Win32_Process
 do {$changed=$false;foreach($process in $all){if($known.Contains([int]$process.ParentProcessId)-and !$known.Contains([int]$process.ProcessId)) {[void]$known.Add([int]$process.ProcessId);$processes.Add(@{pid=[int]$process.ProcessId;parent=[int]$process.ParentProcessId;name=$process.Name});$changed=$true}}}while($changed)
 $ids=@($all | Where-Object {$known.Contains([int]$_.ProcessId)} | ForEach-Object {[int]$_.ProcessId})
 if($ids.Count) {
  # Provider-side PID selection; no packet/payload capture or unrelated socket logs.
  $tcp=@(Get-NetTCPConnection -OwningProcess $ids -ErrorAction SilentlyContinue)
  $udp=@(Get-NetUDPEndpoint -OwningProcess $ids -ErrorAction SilentlyContinue)
  foreach($row in $tcp){$key="tcp/$($row.OwningProcess)/$($row.LocalAddress)/$($row.LocalPort)/$($row.RemoteAddress)/$($row.RemotePort)/$($row.State)";if($seen.Add($key)){$records.Add(@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();protocol='tcp';pid=$row.OwningProcess;localAddress=$row.LocalAddress;localPort=$row.LocalPort;remoteAddress=$row.RemoteAddress;remotePort=$row.RemotePort;state=[string]$row.State})}}
  foreach($row in $udp){$key="udp/$($row.OwningProcess)/$($row.LocalAddress)/$($row.LocalPort)";if($seen.Add($key)){$records.Add(@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();protocol='udp';pid=$row.OwningProcess;localAddress=$row.LocalAddress;localPort=$row.LocalPort})}}
 }
 $samples++;Start-Sleep -Milliseconds 200
}
@{rootPid=$RootProcessId;started=$started;ended=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();samples=$samples;processes=@($processes);sockets=@($records)} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'process-sockets.json')
