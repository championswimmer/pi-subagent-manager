#!/usr/bin/env python3
"""Credential-free POSIX PTY smoke test. Run from the repo after npm install.

Uses real Pi/TUI regular and fullscreen modes, offline, with an unused dummy key.
No model prompts are submitted; temporary session/preferences are removed.
"""
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ansi = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
for mode in ('regular', 'fullscreen'):
  with tempfile.TemporaryDirectory(prefix='pi-nav-pty-') as home:
    os.mkdir(home + '/subagent-manager')
    open(home + '/subagent-manager/.import-offered', 'w').close()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
    env = dict(os.environ, PI_CODING_AGENT_DIR=home, TERM='xterm-256color', PI_OFFLINE='1')
    args = ['node', repo + '/node_modules/@earendil-works/pi-coding-agent/dist/cli.js', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--offline', '--provider', 'openai', '--model', 'gpt-4o-mini', '--api-key', 'unused-pty-smoke-key', '--tui-mode', mode, '-e', repo + '/src/index.ts']
    proc = subprocess.Popen(args, cwd=home, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    def drain(seconds=1):
      end = time.monotonic() + seconds
      chunk = bytearray()
      while time.monotonic() < end:
        if select.select([master], [], [], min(.1, max(0, end-time.monotonic())))[0]:
          try: data = os.read(master, 65536)
          except OSError: break
          if not data: break
          chunk.extend(data)
      return ansi.sub(b'', bytes(chunk)).decode('utf-8', 'replace')
    def send(data): os.write(master, data)
    try:
      start = drain(5)
      if proc.poll() is not None: raise RuntimeError('Pi exited during startup: ' + start[-2000:])
      # Physical Left in empty input, not a slash command, must open the tree.
      send(b'\x1b[D'); tree = drain(1)
      assert 'Esc main' in tree or 'watch' in tree.lower(), ('Left did not open tree', tree[-2000:])
      # Root Enter returns to the main editor without any model call.
      send(b'\r'); drain(.3)
      send(b'unfinished draft'); drain(.3)
      send(b'\x1b[1;5H\x1b[D'); draft_tree = drain(.7)
      assert 'Esc main' in draft_tree or 'watch' in draft_tree.lower(), ('Draft Left did not open', draft_tree[-2000:])
      if mode == 'fullscreen':
        # Kitty Ctrl+Shift+F search shortcut: it must not stack above navigation.
        send(b'\x1b[102;6u'); search = drain(.3)
        assert 'Search ' not in search, ('Host search stacked', search[-2000:])
      send(b'\x1b'); restored = drain(.7)
      assert 'unfinished draft' in restored, ('Draft was not restored', restored[-2000:])
      # Resize then re-enter; the host must not crash from oversized frames.
      fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 18, 60, 0, 0)); os.kill(proc.pid, signal.SIGWINCH)
      drain(.4); send(b'\x1b[D'); resized = drain(.7)
      assert proc.poll() is None, 'Exited after resize'
      assert 'Esc main' in resized or 'watch' in resized.lower(), ('Resize did not render tree', resized[-1000:])
      send(b'\x1b'); drain(.2)
      print(mode + ': Left entry, root Enter, draft restoration, resize, search suppression (fullscreen) PASS')
    finally:
      os.killpg(proc.pid, signal.SIGTERM) if proc.poll() is None else None
      try: proc.wait(timeout=5)
      except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
      os.close(master)
