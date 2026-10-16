import { publicApi } from "../../../lib/public-preview.mjs";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { agentMessages } from "../../../db/schema";

const agents = new Set(["AEGIS", "ORION", "NEXUS", "ORION_SHADOW", "OPERATOR"]);
const responsePolicies = new Set(["REPLY_REQUIRED", "ACK_ONLY", "NO_REPLY"]);
const messageKinds = new Set(["DIRECTIVE", "QUESTION", "REPORT", "DECISION", "ALERT"]);
const priorities = new Set(["P0", "P1", "P2", "P3"]);
const mutableStatuses = new Set(["ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED", "ESCALATED"]);

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function initialStatus(responsePolicy: string) {
  return responsePolicy === "REPLY_REQUIRED" ? "WAITING_REPLY" : "DELIVERED";
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected mailbox error";
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("agent-mailbox", "GET");

  try {
    const url = new URL(request.url);
    const recipient = text(url.searchParams.get("recipient"));
    const status = text(url.searchParams.get("status"));
    const filters = [];
    if (recipient) filters.push(eq(agentMessages.recipient, recipient));
    if (status) filters.push(eq(agentMessages.status, status));

    const db = await getDb();
    const rows = await db
      .select()
      .from(agentMessages)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
      .limit(100);

    return Response.json({ messages: rows });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("agent-mailbox", "POST");

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const sender = text(payload.sender);
    const recipient = text(payload.recipient);
    const responsePolicy = text(payload.responsePolicy);
    const messageKind = text(payload.messageKind);
    const priority = text(payload.priority) || "P2";
    const subject = text(payload.subject);
    const body = text(payload.body);
    const inReplyToId = text(payload.inReplyToId) || null;
    const correlationId = text(payload.correlationId) || crypto.randomUUID();

    if (!agents.has(sender) || !agents.has(recipient)) {
      return Response.json({ error: "sender and recipient must be registered agents" }, { status: 400 });
    }
    if (!responsePolicies.has(responsePolicy) || !messageKinds.has(messageKind)) {
      return Response.json({ error: "invalid message kind or response policy" }, { status: 400 });
    }
    if (!priorities.has(priority) || !subject || !body) {
      return Response.json({ error: "priority, subject and body are required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const db = await getDb();
    const [message] = await db
      .insert(agentMessages)
      .values({
        id,
        correlationId,
        inReplyToId,
        sender,
        recipient,
        responsePolicy,
        messageKind,
        priority,
        subject,
        body,
        status: initialStatus(responsePolicy),
        dueAt: text(payload.dueAt) || null,
        createdAt: now,
      })
      .returning();

    if (inReplyToId) {
      await db
        .update(agentMessages)
        .set({ status: "RESOLVED", respondedAt: now })
        .where(eq(agentMessages.id, inReplyToId));
    }

    return Response.json({ message }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  if (process.env.AEGIS_PUBLIC_PROFILE !== "CUSTOM_INTEGRATION") return publicApi("agent-mailbox", "PATCH");

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const id = text(payload.id);
    const status = text(payload.status);
    if (!id || !mutableStatuses.has(status)) {
      return Response.json({ error: "valid id and mutable status are required" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const db = await getDb();
    const [message] = await db
      .update(agentMessages)
      .set({
        status,
        acknowledgedAt: status === "ACKNOWLEDGED" ? now : undefined,
        respondedAt: status === "RESOLVED" ? now : undefined,
      })
      .where(eq(agentMessages.id, id))
      .returning();

    if (!message) return Response.json({ error: "message not found" }, { status: 404 });
    return Response.json({ message });
  } catch (error) {
    return errorResponse(error);
  }
}
