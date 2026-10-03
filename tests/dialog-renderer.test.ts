import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  TuiAltScreen,
  TuiMainScreen,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import { ConfigStore } from "../src/config.ts";
import { configureAgents } from "../src/settings-ui.ts";
import { DIALOG_OPTIONS, withDialogSession } from "../src/dialog.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings } from "../src/settings.ts";

class RecordingTerminal implements Terminal {
  columns = 100;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  input: (data: string) => void = () => {};
  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(lines: number): void {
    this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
  }
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {
    this.write("\x1b[2K");
  }
  clearFromCursor(): void {
    this.write("\x1b[J");
  }
  clearScreen(): void {
    this.write("\x1b[2J");
  }
  setTitle(): void {}
  setProgress(): void {}
}

const theme = { fg: (_color: string, text: string) => text } as Theme;
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  for (const rows of [12, 24, 40]) {
    test(`${Renderer.name}: settings transitions keep the overlay mounted and avoid full redraws (${rows} rows)`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "pi-dialog-renderer-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const terminal = new RecordingTerminal();
      terminal.rows = rows;
      const tui = new Renderer(terminal);
      t.after(() => tui.stop());
      tui.addChild({
        invalidate() {},
        render: () => ["Conversation behind the settings dialog"],
      });
      tui.start();
      let opened = 0;
      let closed = 0;
      let applied = 0;
      let overlay: OverlayHandle | undefined;
      const notifications: string[] = [];
      const ctx = {
        cwd: root,
        hasUI: true,
        mode: "tui",
        isProjectTrusted: () => true,
        ui: {
          notify: (message: string) => notifications.push(message),
          custom: (factory: Function, options: any) => {
            opened++;
            return new Promise((resolve, reject) => {
              let finished = false;
              let component: any;
              const done = (value: unknown) => {
                if (finished) return;
                finished = true;
                closed++;
                overlay?.hide();
                component?.dispose?.();
                resolve(value);
              };
              Promise.resolve(factory(tui, theme, {}, done)).then((view) => {
                if (finished) return;
                component = view;
                overlay = tui.showOverlay(view, options.overlayOptions);
              }, reject);
            });
          },
        },
      } as unknown as ExtensionCommandContext;
      const store = new ConfigStore({
        cwd: root,
        agentDir: root,
        includeProject: false,
      });
      const running = configureAgents(ctx, {
        store,
        agentDir: root,
        settings: { ...DEFAULT_MANAGER_SETTINGS },
        apply: () => applied++,
      });
      await settle();
      tui.renderNow();
      const bounds = overlay?.getBounds();
      assert.ok(bounds);
      const redraws = tui.fullRedraws;
      terminal.writes = [];

      async function input(data: string): Promise<void> {
        terminal.input(data);
        // Exercise the render boundary before Promise continuations mount the
        // next view: completing a field must not expose the conversation.
        assert.equal(tui.hasOverlay(), true);
        assert.equal(closed, 0);
        tui.renderNow();
        assert.deepEqual(overlay?.getBounds(), bounds);
        await settle();
        tui.renderNow();
        assert.equal(opened, 1);
        assert.deepEqual(overlay?.getBounds(), bounds);
        assert.equal(tui.fullRedraws, redraws);
        assert.ok(!terminal.writes.join("").includes("\x1b[2J"));
      }

      // Invalid input returns to the same menu; valid input updates its draft.
      await input("\r");
      await input("\x05");
      await input("\x15");
      await input("33");
      await input("\r");
      assert.ok(notifications.some((message) => message.includes("at most 32")));
      await input("\r");
      await input("\x05");
      await input("\x15");
      await input("5");
      await input("\r");
      // A canceled field editor, a scope toggle and the nested definitions
      // editor all remain inside the same outer overlay.
      await input("\r");
      await input("\x1b");
      for (let i = 0; i < 4; i++) await input("\x1b[B");
      await input("\r");
      await input("\x1b[B");
      await input("\r");
      await input("\x1b");
      terminal.input("\x13");
      await running;
      assert.equal(opened, 1);
      assert.equal(closed, 1);
      assert.equal(tui.hasOverlay(), false);
      assert.equal(applied, 1);
      assert.equal(
        loadManagerSettings({
          cwd: root,
          agentDir: root,
          includeProject: false,
        }).settings.maxLevels,
        5,
      );
    });
  }

  test(`${Renderer.name}: a non-overlay custom view restores session focus`, async (t) => {
    const terminal = new RecordingTerminal();
    const tui = new Renderer(terminal);
    t.after(() => tui.stop());
    const background = { invalidate() {}, render: () => ["conversation"], focused: false };
    tui.addChild(background);
    tui.setFocus(background);
    tui.start();
    let outer: any;
    let overlay: OverlayHandle | undefined;
    let opens = 0;
    const ctx = {
      ui: {
        custom: (factory: Function, options: any) => {
          return new Promise((resolve, reject) => {
            const done = (value: unknown) => {
              if (options?.overlay) overlay?.hide();
              else tui.setFocus(background); // Pi restores its normal editor here.
              resolve(value);
            };
            Promise.resolve(factory(tui, theme, {}, done)).then((component) => {
              if (options?.overlay) {
                opens++;
                outer = component;
                overlay = tui.showOverlay(component, options.overlayOptions);
              }
            }, reject);
          });
        },
      },
    } as unknown as ExtensionCommandContext;
    let passThroughCompleted = false;
    const running = withDialogSession(ctx, async (sessionCtx) => {
      const view = (
        _host: unknown,
        _theme: unknown,
        _keys: unknown,
        done: (value?: unknown) => void,
      ) => ({
        invalidate() {},
        render: () => ["view"],
        handleInput: () => done(),
      });
      await sessionCtx.ui.custom(view, DIALOG_OPTIONS);
      await sessionCtx.ui.custom((_host, _theme, _keys, done) => {
        done(undefined);
        return { invalidate() {}, render: () => [] };
      });
      passThroughCompleted = true;
      await sessionCtx.ui.custom(view, DIALOG_OPTIONS);
    });
    await settle();
    terminal.input("\r");
    await settle();
    assert.equal(passThroughCompleted, true);
    assert.equal(opens, 1);
    assert.equal(tui.getFocusedComponent(), outer);
    assert.equal(outer.focused, true);
    terminal.input("\r");
    await running;
    assert.equal(tui.hasOverlay(), false);
  });

  for (const throws of [false, true]) {
    test(`${Renderer.name}: immediately ${throws ? "throwing" : "finishing"} workflows leave no overlay`, async (t) => {
      const terminal = new RecordingTerminal();
      const tui = new Renderer(terminal);
      t.after(() => tui.stop());
      tui.start();
      const ctx = {
        ui: {
          custom: (factory: Function, options: any) =>
            new Promise((resolve, reject) => {
              let overlay: OverlayHandle | undefined;
              const done = () => {
                overlay?.hide();
                resolve(undefined);
              };
              Promise.resolve(factory(tui, theme, {}, done)).then((component) => {
                overlay = tui.showOverlay(component, options.overlayOptions);
              }, reject);
            }),
        },
      } as unknown as ExtensionCommandContext;
      const running = withDialogSession(ctx, () => {
        if (throws) throw new Error("immediate failure");
        return Promise.resolve();
      });
      if (throws) await assert.rejects(running, /immediate failure/);
      else await running;
      await settle();
      assert.equal(tui.hasOverlay(), false);
    });
  }
}
