import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  DIALOG_OPTIONS,
  DialogEditor,
  DialogSession,
  dialogHeight,
  withDialogSession,
} from "../src/dialog.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

function host() {
  return { requestRender() {}, terminal: { rows: 24 } };
}

test(
  "DialogSession delegates focus and ignores keys after a child finishes",
  { timeout: 8000 },
  async () => {
    const mounted: any[] = [];
    let notify = () => {};
    const driver = createDialogDriver({ theme, width: 80, timeoutMs: 3000 });
    driver.onChild = (component) => {
      mounted.push(component);
      notify();
      return true;
    };
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: driver.custom, notify() {} },
    } as unknown as ExtensionCommandContext;
    const wait = (index: number) => {
      if (mounted[index]) return Promise.resolve(mounted[index]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`dialog child ${index} was not mounted`)),
          2000,
        );
        notify = () => {
          if (!mounted[index]) return;
          clearTimeout(timer);
          resolve(mounted[index]);
        };
      });
    };

    const doneCalls: unknown[] = [];
    await withDialogSession(ctx, async (sessionCtx) => {
      const first = sessionCtx.ui.custom(
        (childHost, childTheme, _keys, done) => {
          return new DialogEditor(
            childHost,
            childTheme,
            "Prompt",
            "hello",
            (value) => {
              doneCalls.push(value);
              done(value);
            },
          );
        },
        DIALOG_OPTIONS,
      );
      const editor = await wait(0);
      const session = driver.session;
      assert.ok(session instanceof DialogSession);
      assert.equal(session.getComponent(), editor);
      session.focused = true;
      assert.equal(editor.focused, true);
      assert.equal(session.focused, true);
      const rendered = session.render(80);
      assert.equal(rendered.length, dialogHeight(host()));
      assert.ok(rendered.some((line: string) => line.includes(CURSOR_MARKER)));
      editor.handleInput("\x1b");
      assert.equal(await first, undefined);
      assert.deepEqual(doneCalls, [undefined]);
      session.handleInput("\x13");
      session.handleInput("x");
      assert.deepEqual(
        doneCalls,
        [undefined],
        "keyboard input must be ignored after the child is done until the next mount",
      );

      const secondCalls: string[] = [];
      const second = sessionCtx.ui.custom((_host, _theme, _keys, done) => {
        return {
          handleInput(data: string) {
            secondCalls.push(data);
            if (data === "\r") done("second");
          },
          invalidate() {},
          render: () => ["next"],
        };
      }, DIALOG_OPTIONS);
      await wait(1);
      assert.equal(session.getComponent(), mounted[1]);
      session.handleInput("\r");
      assert.deepEqual(secondCalls, ["\r"]);
      assert.equal(await second, "second");
    });
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(driver.stats.outerCompletions, 1);
    assert.equal(driver.stats.forcedRenders, 0);
  },
);

test(
  "withDialogSession shadows getter-only ui without mutating the original context",
  { timeout: 8000 },
  async () => {
    const driver = createDialogDriver({ theme, timeoutMs: 3000 });
    driver.onChild = () => true;
    const notifications: string[] = [];
    const ui = {
      custom: driver.custom,
      notify(message: string) {
        notifications.push(message);
      },
    };
    let cwd = "/original";
    const ctx = Object.freeze({
      hasUI: true,
      mode: "tui",
      get ui() {
        return ui;
      },
      get cwd() {
        return cwd;
      },
    }) as unknown as ExtensionCommandContext;

    await withDialogSession(ctx, async (sessionCtx) => {
      assert.notEqual(sessionCtx, ctx);
      assert.notEqual(sessionCtx.ui, ui);
      assert.equal(ctx.ui, ui);
      sessionCtx.ui.notify("scoped notification");
      assert.deepEqual(notifications, ["scoped notification"]);
      assert.equal(sessionCtx.cwd, "/original");
      cwd = "/updated";
      assert.equal(sessionCtx.cwd, "/updated", "other context getters stay live");
      await withDialogSession(sessionCtx, async (nestedCtx) => {
        assert.equal(nestedCtx, sessionCtx);
        const result = await nestedCtx.ui.custom((_host, _theme, _keys, done) => {
          done("ok");
          return { invalidate() {}, render: () => ["child"] };
        }, DIALOG_OPTIONS);
        assert.equal(result, "ok");
      });
    });

    assert.equal(ctx.ui, ui);
    assert.equal(ctx.ui.custom, driver.custom);
    assert.equal(Object.getOwnPropertyDescriptor(ctx, "ui")?.set, undefined);
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(driver.stats.outerCompletions, 1);
  },
);

test(
  "withDialogSession closes the outer overlay when the flow throws",
  { timeout: 8000 },
  async () => {
    const driver = createDialogDriver({ theme, timeoutMs: 3000 });
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: driver.custom, notify() {} },
    } as unknown as ExtensionCommandContext;
    await assert.rejects(
      () =>
        withDialogSession(ctx, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(driver.stats.outerCompletions, 1);
    assert.equal(driver.stats.forcedRenders, 0);
  },
);

test(
  "a failing child does not leave the outer overlay open",
  { timeout: 8000 },
  async () => {
    const driver = createDialogDriver({ theme, timeoutMs: 3000 });
    driver.onChild = () => true;
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: { custom: driver.custom, notify() {} },
    } as unknown as ExtensionCommandContext;
    let recovered = false;
    await withDialogSession(ctx, async (sessionCtx) => {
      await assert.rejects(
        () =>
          sessionCtx.ui.custom(() => {
            throw new Error("child");
          }, DIALOG_OPTIONS),
        /child/,
      );
      const pending = sessionCtx.ui.custom((_host, _theme, _keys, done) => {
        done("ok");
        return { invalidate() {}, render: () => ["recovered"] };
      }, DIALOG_OPTIONS);
      assert.equal(await pending, "ok");
      recovered = true;
    });
    assert.equal(recovered, true);
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(driver.stats.outerCompletions, 1);
  },
);
