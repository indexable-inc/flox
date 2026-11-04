{
  runCommand,
  stdenv,
  meson,
  ninja,
  pkg-config,
  python3,
  gitMinimal,
}:
runCommand "meson-reuse"
  {
    nativeBuildInputs = [
      stdenv.cc
      meson
      ninja
      pkg-config
      python3
      gitMinimal
    ];
  }
  ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    python3 ${./meson-reuse.py} ${../shells/configure-nix-plugins.sh} ${stdenv.cc}
    touch "$out"
  ''
