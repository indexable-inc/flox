"""Exercise the development shell's real Meson setup against a C++ project."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SETUP = Path(sys.argv.pop(1)).resolve()
COMPILER_PACKAGE = sys.argv.pop(1)


class MesonReuse(unittest.TestCase):
    def test_reuses_objects_and_rebuilds_changed_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            build = root / "build"
            source.mkdir()
            dependency = root / "dependency"
            dependency.mkdir()
            source.joinpath("meson.build").write_text(
                "project('reuse', 'cpp')\n"
                "executable('probe', 'probe.cc', dependencies: dependency('probe-dep'))\n"
            )
            code = "#include <cstdio>\nint main() { std::printf(\"%d\\n\", DEP_VALUE + 1); }\n"
            source.joinpath("probe.cc").write_text(code)
            pc = dependency / "probe-dep.pc"

            def write_dependency(value):
                pc.write_text(
                    "Name: probe-dep\nDescription: cache test\nVersion: 1\n"
                    f"Cflags: -DDEP_VALUE={value}\n"
                )

            env = dict(os.environ, CXX="c++", PKG_CONFIG_PATH=str(dependency))

            def run(*command):
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return result.stdout

            def configure():
                run("bash", str(SETUP), COMPILER_PACKAGE, str(source), str(build), str(root / "install"))

            def compile_and_output():
                run("meson", "compile", "-C", str(build))
                return run(str(build / "probe")).strip()

            write_dependency(10)
            configure()
            self.assertEqual(compile_and_output(), "11")
            objects = list(build.rglob("*.o"))
            self.assertEqual(len(objects), 1)
            unchanged = [(obj.stat().st_ino, obj.stat().st_mtime_ns) for obj in objects]
            configure()
            self.assertEqual(compile_and_output(), "11")
            self.assertEqual(
                [(obj.stat().st_ino, obj.stat().st_mtime_ns) for obj in objects], unchanged,
                "entering the same shell must preserve compiled objects",
            )

            source.joinpath("probe.cc").write_text(code.replace("+ 1", "+ 2"))
            configure()
            self.assertEqual(compile_and_output(), "12")
            write_dependency(20)
            configure()
            self.assertEqual(compile_and_output(), "22", "dependency flags must be re-read")

            # A second compiler command adds a define. Meson must stop using
            # the compiler retained in the previous build directory.
            compiler = shutil.which("c++")
            self.assertIsNotNone(compiler)
            shell = shutil.which("sh")
            self.assertIsNotNone(shell)
            wrapper = root / "other-cxx"
            wrapper.write_text(f'#!{shell}\nexec "{compiler}" -DCOMPILER_VALUE=100 "$@"\n')
            wrapper.chmod(0o755)
            source.joinpath("probe.cc").write_text(code.replace("DEP_VALUE + 1", "DEP_VALUE + COMPILER_VALUE"))
            env["CXX"] = str(wrapper)
            configure()
            self.assertEqual(compile_and_output(), "120", "compiler changes must take effect")


unittest.main()
