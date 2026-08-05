import { describe, expect, it } from "vitest";

import { createFakeBucket } from "../test-support/r2";
import type { TelegramUpdate } from "../telegram/types";
import { intakeUpdate } from "./intake";

const SENDER = 4242;

function textMessage(text: string | undefined): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: 99, type: "private" },
      from: { id: SENDER },
      ...(text === undefined ? {} : { text }),
    },
  };
}

describe("intakeUpdate", () => {
  it("stores a draft for a text message", async () => {
    const { bucket, objects } = createFakeBucket();
    const result = await intakeUpdate(textMessage("a morning run"), SENDER, { PRIVATE_BUCKET: bucket });

    expect(result.status).toBe("created");
    expect(objects.size).toBe(1);
  });

  it("records where the message came from so the preview can be sent back", async () => {
    const { bucket } = createFakeBucket();
    const result = await intakeUpdate(textMessage("a morning run"), SENDER, { PRIVATE_BUCKET: bucket });

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.source).toEqual({ chatId: 99, senderId: SENDER, messageId: 7 });
  });

  it("trims the incoming text", async () => {
    const { bucket } = createFakeBucket();
    const result = await intakeUpdate(textMessage("  a morning run \n"), SENDER, { PRIVATE_BUCKET: bucket });

    if (result.status !== "created") throw new Error("expected a draft");
    expect(result.draft.input.text).toBe("a morning run");
  });

  it("ignores a message with no text at all", async () => {
    const { bucket, objects } = createFakeBucket();
    const result = await intakeUpdate(textMessage(undefined), SENDER, { PRIVATE_BUCKET: bucket });

    expect(result.status).toBe("unsupported");
    expect(objects.size).toBe(0);
  });

  it("ignores a message that is only whitespace", async () => {
    const { bucket, objects } = createFakeBucket();
    const result = await intakeUpdate(textMessage("   \n  "), SENDER, { PRIVATE_BUCKET: bucket });

    expect(result.status).toBe("unsupported");
    expect(objects.size).toBe(0);
  });

  it("does not start a second draft when a message is edited in Telegram", async () => {
    // Someone fixing a typo would otherwise end up with two drafts for one
    // thought. Editing a draft is the preview buttons' job, not this one's.
    const { bucket, objects } = createFakeBucket();
    const update: TelegramUpdate = { update_id: 2, edited_message: textMessage("a morning run").message };

    expect((await intakeUpdate(update, SENDER, { PRIVATE_BUCKET: bucket })).status).toBe("unsupported");
    expect(objects.size).toBe(0);
  });

  it("ignores a button press", async () => {
    const { bucket, objects } = createFakeBucket();
    const update: TelegramUpdate = {
      update_id: 3,
      callback_query: { id: "cb", from: { id: SENDER }, data: "publish" },
    };

    expect((await intakeUpdate(update, SENDER, { PRIVATE_BUCKET: bucket })).status).toBe("unsupported");
    expect(objects.size).toBe(0);
  });
});
