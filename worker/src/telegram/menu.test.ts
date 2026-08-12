import { describe, expect, it } from "vitest";

import { BOT_COMMANDS, COMMANDS, parseCommand } from "./commands";
import {
  ADD_MEDIA_LABEL,
  MAIN_KEYBOARD,
  NEW_ACTIVITY_LABEL,
  RAW_LABEL,
  REMOVE_MEDIA_LABEL,
  REPOST_LABEL,
  menuAction,
} from "./menu";

describe("parseCommand", () => {
  it("recognises the bot's own commands", () => {
    expect(parseCommand("/start")).toBe("start");
    expect(parseCommand("/new")).toBe("new");
    expect(parseCommand("/raw")).toBe("raw");
    expect(parseCommand("/repost")).toBe("repost");
    expect(parseCommand("/addmedia")).toBe("addmedia");
    expect(parseCommand("/removemedia")).toBe("removemedia");
  });

  it("ignores the arguments after one", () => {
    expect(parseCommand("/repost the last one please")).toBe("repost");
  });

  it("strips the @botname suffix Telegram appends in groups", () => {
    expect(parseCommand("/repost@dina_bot")).toBe("repost");
  });

  it("is case-insensitive, because Telegram's autocomplete is not the only way one arrives", () => {
    expect(parseCommand("/Repost")).toBe("repost");
  });

  // The overwhelmingly common case, and it must stay untouched.
  it("leaves an ordinary message alone", () => {
    expect(parseCommand("Ran 8k this morning")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("not/a/command")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });
});

describe("BOT_COMMANDS", () => {
  /**
   * The "/" menu must not advertise a command the Worker does not answer. These
   * are one list precisely so that cannot happen, and this is the assertion that
   * says so.
   */
  it("registers exactly the commands the parser recognises", () => {
    expect(BOT_COMMANDS.map((entry) => entry.command).sort()).toEqual([...COMMANDS].sort());
  });

  it("describes each one", () => {
    for (const entry of BOT_COMMANDS) expect(entry.description.length).toBeGreaterThan(0);
  });
});

describe("menuAction", () => {
  /**
   * A reply keyboard sends its label as an ordinary message, so these strings
   * are the only thing that tells a button press from a note.
   */
  it("recognises a press of any standing button", () => {
    expect(menuAction(NEW_ACTIVITY_LABEL)).toBe("new");
    expect(menuAction(REPOST_LABEL)).toBe("repost");
    expect(menuAction(ADD_MEDIA_LABEL)).toBe("addmedia");
    expect(menuAction(REMOVE_MEDIA_LABEL)).toBe("removemedia");
  });

  it("treats a button and its command as the same action", () => {
    expect(menuAction("/new")).toBe(menuAction(NEW_ACTIVITY_LABEL));
    expect(menuAction("/repost")).toBe(menuAction(REPOST_LABEL));
    expect(menuAction("/addmedia")).toBe(menuAction(ADD_MEDIA_LABEL));
    expect(menuAction("/removemedia")).toBe(menuAction(REMOVE_MEDIA_LABEL));
  });

  it("leaves a note that merely mentions a button alone", () => {
    expect(menuAction(`Thinking about a ${REPOST_LABEL} later`)).toBeNull();
  });

  it("leaves an ordinary note alone", () => {
    expect(menuAction("Ran 8k this morning")).toBeNull();
  });
});

describe("MAIN_KEYBOARD", () => {
  it("draws the buttons menuAction matches on, and no others", () => {
    expect(MAIN_KEYBOARD.keyboard.flat().map((button) => button.text)).toEqual([
      NEW_ACTIVITY_LABEL,
      RAW_LABEL,
      REPOST_LABEL,
      ADD_MEDIA_LABEL,
      REMOVE_MEDIA_LABEL,
    ]);
  });

  // The whole point is that it is still there tomorrow, and that it does not
  // reserve half the screen for two rows.
  it("stays open and sized to its contents", () => {
    expect(MAIN_KEYBOARD.is_persistent).toBe(true);
    expect(MAIN_KEYBOARD.resize_keyboard).toBe(true);
  });
});
