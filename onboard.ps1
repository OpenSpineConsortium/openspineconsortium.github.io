# OpenSpineConsortium onboarding, Windows (PowerShell):
#
#     irm https://openspineconsortium.com/onboard.ps1 | iex
#
# Installs what is missing (Git for Windows, the GitHub CLI, VS Code with the Claude Code
# extension, Claude Code), clones the public Student_Projects repository into
# %USERPROFILE%\OpenSpineConsortium\Student_Projects, and starts Claude Code there on the
# /onboard command, which does the rest with you. Safe to run again.
$ErrorActionPreference = "Continue"
$Dir  = Join-Path $HOME "OpenSpineConsortium\Student_Projects"
$Repo = "https://github.com/OpenSpineConsortium/Student_Projects.git"
function Say($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function RefreshPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
Say "OpenSpineConsortium onboarding (Windows)"
if (-not (Have "winget")) { Write-Host "  winget is missing. Install 'App Installer' from the Microsoft Store, then rerun."; return }

function WingetInstall($cmd, $id) {
  if (Have $cmd) { Write-Host "  ${cmd}: present"; return }
  Say "Installing $id"
  winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent | Out-Null
  RefreshPath
}
WingetInstall "git"  "Git.Git"
WingetInstall "gh"   "GitHub.cli"
WingetInstall "code" "Microsoft.VisualStudioCode"
if (Have "code") { code --install-extension anthropic.claude-code --force | Out-Null; Write-Host "  VS Code: Claude Code extension installed" }

if (-not (Have "claude")) {
  Say "Installing Claude Code"
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  RefreshPath
}
if (Have "claude") { Write-Host ("  claude: " + (claude --version 2>$null)) }

New-Item -ItemType Directory -Force (Split-Path $Dir) | Out-Null
if (Test-Path (Join-Path $Dir ".git")) { Say "Updating $Dir"; git -C $Dir pull -q --ff-only }
else { Say "Cloning Student_Projects into $Dir"; git clone -q $Repo $Dir }

Say "Ready. Starting Claude Code in $Dir on /onboard."
Write-Host "  (Sign in when the browser opens; Claude Pro, about `$20 a month, includes Claude Code.)"
Write-Host "  Later: cd `"$Dir`"; claude"
Set-Location $Dir
claude "/onboard"
