import {
  assertEqual,
  ensureProfiles,
  expectError,
  expectOk,
  gql,
  redis,
  resetData,
  socketClient,
  step,
} from "./helpers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(
  response: Awaited<ReturnType<typeof gql>>,
  objectName: string,
  fieldName: string
): unknown {
  const object = response.data?.[objectName];
  if (!isRecord(object)) throw new Error(`${objectName} was not returned.`);
  return object[fieldName];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(): Promise<void> {
  await resetData();
  await ensureProfiles();

  await gql("alice", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("bob", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');
  await gql("carol", 'mutation { updateProfile(input: { isPrivate: false }) { id } }');

  let conversationId = "";
  let aliceSocket: Awaited<ReturnType<typeof socketClient>> | null = null;
  let bobSocket: Awaited<ReturnType<typeof socketClient>> | null = null;
  try {
    if (!(await step("direct conversation is idempotent and rejects self-chat", async () => {
      const first = await gql(
        "alice",
        'mutation { startConversation(username: "bob") { id } }'
      );
      expectOk(first);
      conversationId = String(field(first, "startConversation", "id"));

      const second = await gql(
        "alice",
        'mutation { startConversation(username: "bob") { id } }'
      );
      expectOk(second);
      assertEqual(field(second, "startConversation", "id"), conversationId, "same conversation id");

      const self = await gql(
        "alice",
        'mutation { startConversation(username: "alice") { id } }'
      );
      expectError(self, "BAD_USER_INPUT");
    }))) return;

    aliceSocket = await socketClient("alice");
    await aliceSocket.once<{ userId: string }>("ready");
    bobSocket = await socketClient("bob");
    await bobSocket.once<{ userId: string }>("ready");

    if (!(await step("socket send delivers a message and is idempotent", async () => {
      const bobMessage = bobSocket!.once<{ id: string; conversationId: string }>("message:new");
      const first = await aliceSocket!.emitAck<{ ok: boolean; message: { id: string } }>(
        "message:send",
        { conversationId, body: "Hello Bob", clientId: "client-one" }
      );
      assertEqual(first.ok, true, "socket send ack");
      const received = await bobMessage;
      assertEqual(received.conversationId, conversationId, "socket message conversation");

      const second = await aliceSocket!.emitAck<{ ok: boolean; message: { id: string } }>(
        "message:send",
        { conversationId, body: "Hello Bob", clientId: "client-one" }
      );
      assertEqual(second.ok, true, "idempotent send ack");
      assertEqual(second.message.id, first.message.id, "same message id");
      await wait(200);

      const rows = await gql(
        "alice",
        "query Messages($id: ID!) { messages(conversationId: $id, first: 30) { items { id } } }",
        { id: conversationId }
      );
      expectOk(rows);
      const page = rows.data?.messages;
      assertEqual(
        isRecord(page) && Array.isArray(page.items) ? page.items.length : -1,
        1,
        "one stored message"
      );
    }))) return;

    if (!(await step("unread count, read receipt, and typing events work", async () => {
      const bobUnread = await gql(
        "bob",
        "query Conversation($id: ID!) { conversation(id: $id) { unreadCount } }",
        { id: conversationId }
      );
      expectOk(bobUnread);
      assertEqual(field(bobUnread, "conversation", "unreadCount"), 1, "Bob unread count");
      const bobId = await bobUserId();
      const hashCount = await redis.hget(`chat:unread:${bobId}`, conversationId);
      assertEqual(hashCount, "1", "Bob Redis unread hash");

      const aliceRead = aliceSocket!.once<{ conversationId: string; userId: string }>("message:read");
      await gql(
        "bob",
        "mutation Read($id: ID!) { markConversationRead(conversationId: $id) }",
        { id: conversationId }
      );
      const read = await aliceRead;
      assertEqual(read.conversationId, conversationId, "read receipt conversation");
      assertEqual(read.userId, await bobUserId(), "read receipt user");

      const bobTyping = bobSocket!.once<{ conversationId: string; isTyping: boolean }>("typing");
      aliceSocket!.socket.emit("typing:start", { conversationId });
      const typing = await bobTyping;
      assertEqual(typing.conversationId, conversationId, "typing conversation");
      assertEqual(typing.isTyping, true, "typing true");
    }))) return;

    if (!(await step("message pagination is newest-first and non-members are denied", async () => {
      await gql(
        "alice",
        "mutation Send($input: SendMessageInput!) { sendMessage(input: $input) { id } }",
        { input: { conversationId, body: "Second", clientId: "client-two" } }
      );
      const page = await gql(
        "alice",
        "query Messages($id: ID!) { messages(conversationId: $id, first: 1) { items { body } nextCursor } }",
        { id: conversationId }
      );
      expectOk(page);
      const result = page.data?.messages;
      if (!isRecord(result) || !Array.isArray(result.items)) throw new Error("Messages invalid.");
      assertEqual(result.items[0] && isRecord(result.items[0]) ? result.items[0].body : null, "Second", "newest message");

      const denied = await gql(
        "carol",
        "query Messages($id: ID!) { messages(conversationId: $id, first: 30) { items { id } } }",
        { id: conversationId }
      );
      expectError(denied, "FORBIDDEN");
    }))) return;

    let groupId = "";
    if (!(await step("groups reach members and only sender can delete", async () => {
      const created = await gql(
        "alice",
        'mutation { createGroup(title: "Team", usernames: ["bob", "carol"]) { id } }'
      );
      expectOk(created);
      groupId = String(field(created, "createGroup", "id"));

      const bobNew = bobSocket!.once<{ conversationId: string }>("message:new");
      const carolSocket = await socketClient("carol");
      await carolSocket.once<{ userId: string }>("ready");
      const carolNew = carolSocket.once<{ conversationId: string }>("message:new");
      const sent = await aliceSocket!.emitAck<{ ok: boolean; message: { id: string } }>(
        "message:send",
        { conversationId: groupId, body: "Group hello", clientId: "group-one" }
      );
      assertEqual(sent.ok, true, "group send");
      assertEqual((await bobNew).conversationId, groupId, "bob group delivery");
      assertEqual((await carolNew).conversationId, groupId, "carol group delivery");

      const bobDelete = await gql(
        "bob",
        "mutation Delete($id: ID!) { deleteMessage(messageId: $id) }",
        { id: sent.message.id }
      );
      expectError(bobDelete, "FORBIDDEN");

      const bobDeleted = bobSocket!.once<{ messageId: string }>("message:deleted");
      const deleted = await gql(
        "alice",
        "mutation Delete($id: ID!) { deleteMessage(messageId: $id) }",
        { id: sent.message.id }
      );
      expectOk(deleted);
      const deletedEvent = await bobDeleted;
      assertEqual(deletedEvent.messageId, sent.message.id, "deleted event message id");
      await carolSocket.close();
    }))) return;

    if (!(await step("blocked users cannot send", async () => {
      await gql(
        "bob",
        'mutation { block(username: "alice") { id } }'
      );
      const blocked = await aliceSocket!.emitAck<{ ok: boolean; code: string }>(
        "message:send",
        { conversationId, body: "Blocked", clientId: "blocked-one" }
      );
      assertEqual(blocked.ok, false, "blocked send ack");
      assertEqual(blocked.code, "FORBIDDEN", "blocked send code");
    }))) return;
  } finally {
    if (aliceSocket) await aliceSocket.close();
    if (bobSocket) await bobSocket.close();
  }
}

async function bobUserId(): Promise<string> {
  const response = await gql("bob", "{ me { id } }");
  expectOk(response);
  const id = response.data?.me && isRecord(response.data.me) ? response.data.me.id : null;
  if (typeof id !== "string") throw new Error("Bob id was not returned.");
  return id;
}
