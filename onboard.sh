#!/usr/bin/env bash
# OpenSpineConsortium onboarding, macOS / Linux / WSL:
#
#     curl -fsSL https://openspineconsortium.com/onboard.sh | bash
#
# Installs what is missing (git, the GitHub CLI, VS Code with the Claude Code extension,
# Claude Code), clones the public Student_Projects repository into
# ~/OpenSpineConsortium/Student_Projects, and starts Claude Code there on the /onboard
# command, which does the rest with you. Safe to run again: it only installs what is absent.
set -u
DIR="$HOME/OpenSpineConsortium/Student_Projects"
REPO="https://github.com/OpenSpineConsortium/Student_Projects.git"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
OS="$(uname -s)"
say "OpenSpineConsortium onboarding ($OS)"

# ---- package manager, used only for what is missing -------------------------------------
if [ "$OS" = "Darwin" ] && ! have brew; then
  say "Installing Homebrew (the macOS package manager). It will ask for your Mac password."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
inst() {  # inst <command> <brew formula or cask> <apt package>
  have "$1" && { echo "  $1: present"; return; }
  say "Installing $1"
  if [ "$OS" = "Darwin" ]; then brew install $2 </dev/tty
  elif have apt-get; then sudo apt-get install -y $3 </dev/tty
  elif have dnf; then sudo dnf install -y $3 </dev/tty
  else echo "  ! could not install $1 automatically; install it and rerun."; fi
}

inst git git git
if ! have gh; then
  if [ "$OS" != "Darwin" ] && have apt-get && ! apt-cache show gh >/dev/null 2>&1; then
    say "Adding the GitHub CLI package source"
    (type -p wget >/dev/null || sudo apt-get install -y wget) </dev/tty
    sudo mkdir -p -m 755 /etc/apt/keyrings
    wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -qq
  fi
  inst gh gh gh
fi

# ---- VS Code and the Claude Code extension ----------------------------------------------
if ! have code; then
  if [ "$OS" = "Darwin" ]; then say "Installing Visual Studio Code"; brew install --cask visual-studio-code </dev/tty
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    echo "  VS Code: install it on Windows from https://code.visualstudio.com and use its WSL integration."
  else echo "  VS Code: install it from https://code.visualstudio.com (this script does not manage Linux desktop packages)."; fi
fi
if have code; then code --install-extension anthropic.claude-code --force >/dev/null 2>&1 && echo "  VS Code: Claude Code extension installed"; fi

# ---- Claude Code --------------------------------------------------------------------------
if ! have claude; then
  say "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
have claude && echo "  claude: $(claude --version 2>/dev/null | head -1)"

# ---- the repository -----------------------------------------------------------------------
mkdir -p "$(dirname "$DIR")"
if [ -d "$DIR/.git" ]; then say "Updating $DIR"; git -C "$DIR" pull -q --ff-only || true
else say "Cloning Student_Projects into $DIR"; git clone -q "$REPO" "$DIR"; fi

say "Ready. Starting Claude Code in $DIR on /onboard."
echo "  (Sign in when the browser opens; Claude Pro, about \$20 a month, includes Claude Code.)"
echo "  Later: cd \"$DIR\" && claude"
cd "$DIR" || exit 1
if [ -t 0 ]; then exec claude "/onboard"; else exec claude "/onboard" </dev/tty; fi
