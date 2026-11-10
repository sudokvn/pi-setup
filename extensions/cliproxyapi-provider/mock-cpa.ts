/**
 * Local CLIProxyAPI stand-in for tests. It follows CPA's documented WebSocket behavior for HTTP
 * upstreams: per connection it keeps the last request and response output, expands
 * `previous_response_id` requests to the full input, and merges a later request without
 * assistant items into the stale history. For Anthropic Messages it keeps message threads the
 * way Anthropic documents them: `create` stores the conversation with its reply, and `continue`
 * appends the new messages to the stored one, once per reply. Nothing here describes what CPA's
 * upstreams do.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { NodeWS } from "@effect/platform-node/NodeSocket";

type Json = { readonly [key: string]: unknown };

export interface Reply {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCall?: { readonly name: string; readonly arguments: string };
}

export interface RecordedRequest {
  readonly transport: "websocket" | "sse" | "anthropic";
  readonly connection?: number;
  readonly delta: boolean;
  /** The input CPA would send upstream after its own merge, or the thread's full conversation. */
  readonly merged: readonly unknown[];
  readonly body: Json;
  readonly path: string;
  readonly headers?: IncomingHttpHeaders;
}

export interface Faults {
  /** HTTP status for the next WebSocket upgrades. */
  rejectUpgrade?: number;
  /** Close the socket with this code after the next request arrives, before any event. */
  closeAfterRequest?: number;
  /** Stream the next response up to `response.completed`, then close with this code. */
  closeBeforeCompleted?: number;
  /** Answer the next continuation with `previous_response_not_found`. */
  forgetContinuation?: boolean;
  /** Never answer the next request. */
  stall?: boolean;
  /** Reject the next Anthropic thread `continue` with `thread_not_found`. */
  threadNotFound?: boolean;
  /** Reject the next `continue` like CPA does itself when it lost a thread's tool-name state. */
  cpaThreadStateLost?: boolean;
  /** Answer the next Anthropic request as this model, like a server-side refusal fallback. */
  fallbackModel?: string;
}

export interface MockCpa {
  readonly root: string;
  readonly requests: RecordedRequest[];
  readonly modelRequests: string[];
  readonly faults: Faults;
  connections: number;
  modelsResponse: unknown;
  richResponse: unknown;
  close(): Promise<void>;
}

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasHistory(input: readonly unknown[]): boolean {
  return input.some(
    (item) =>
      isJson(item) &&
      (item.type === "function_call" ||
        item.type === "custom_tool_call" ||
        (item.type === "message" && item.role === "assistant")),
  );
}

let counter = 0;

export function responseEvents(reply: Reply): {
  events: Json[];
  output: Json[];
  id: string;
} {
  const n = ++counter;
  const id = `resp_${n}`;
  const output: Json[] = [];
  if (reply.reasoning !== undefined) {
    output.push({
      type: "reasoning",
      id: `rs_${n}`,
      summary: [{ type: "summary_text", text: reply.reasoning }],
      encrypted_content: `enc_${n}`,
    });
  }
  if (reply.text !== undefined) {
    output.push({
      type: "message",
      id: `msg_${n}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    });
  }
  if (reply.toolCall) {
    output.push({
      type: "function_call",
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: reply.toolCall.name,
      arguments: reply.toolCall.arguments,
      status: "completed",
    });
  }
  const events: Json[] = [
    {
      type: "response.created",
      response: { id, status: "in_progress", output: [] },
    },
  ];
  output.forEach((item, index) => {
    const added =
      item.type === "message"
        ? { ...item, content: [] }
        : item.type === "function_call"
          ? { ...item, arguments: "" }
          : { ...item, summary: [] };
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: added,
    });
    if (item.type === "reasoning") {
      events.push({
        type: "response.reasoning_summary_text.delta",
        output_index: index,
        delta: reply.reasoning,
      });
    } else if (item.type === "message") {
      events.push({
        type: "response.output_text.delta",
        output_index: index,
        delta: reply.text,
      });
    } else {
      events.push({
        type: "response.function_call_arguments.delta",
        output_index: index,
        delta: item.arguments,
      });
      events.push({
        type: "response.function_call_arguments.done",
        output_index: index,
        arguments: item.arguments,
      });
    }
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  });
  events.push({
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: {
        input_tokens: 125,
        output_tokens: 12,
        total_tokens: 137,
        input_tokens_details: { cached_tokens: 100 },
      },
    },
  });
  return { events, output, id };
}

function anthropicEvents(id: string, model: string, text: string): string {
  const frames: [string, Json][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 25,
            output_tokens: 0,
            cache_read_input_tokens: 100,
          },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 12 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return frames
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return isJson(value) ? value : {};
}

export async function startMockCpa(options: {
  readonly apiKey: string;
  readonly reply: (merged: readonly unknown[], body: Json) => Reply;
  readonly models?: readonly { id: string; owned_by?: string }[];
  readonly rich?: readonly Json[];
}): Promise<MockCpa> {
  const authorized = (request: IncomingMessage) =>
    request.headers.authorization === `Bearer ${options.apiKey}` ||
    request.headers["x-api-key"] === options.apiKey;

  const mock: MockCpa = {
    root: "",
    requests: [],
    modelRequests: [],
    faults: {},
    connections: 0,
    modelsResponse: {
      object: "list",
      data: (options.models ?? []).map((model) => ({
        object: "model",
        ...model,
      })),
    },
    richResponse: options.rich ? { models: options.rich } : undefined,
    close: async () => undefined,
  };

  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };

  /** Reply id -> the thread's settings and full conversation including that reply. */
  const threads = new Map<
    string,
    { system: unknown; tools: unknown; messages: readonly unknown[] }
  >();
  let replies = 0;
  const threadError = (response: ServerResponse, code: string) =>
    json(response, 404, {
      type: "error",
      error: {
        type: "not_found_error",
        message: `thread rejected: ${code}`,
        details: { error_code: code },
      },
    });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/models")
      mock.modelRequests.push(url.pathname + url.search);
    if (!authorized(request))
      return json(response, 401, { error: { message: "unauthorized" } });
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return json(
        response,
        200,
        url.searchParams.has("client_version") && mock.richResponse
          ? mock.richResponse
          : mock.modelsResponse,
      );
    }
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const body = await readBody(request);
      const input = Array.isArray(body.input) ? body.input : [];
      mock.requests.push({
        transport: "sse",
        delta: false,
        merged: input,
        body,
        path: url.pathname,
      });
      const { events } = responseEvents(options.reply(input, body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events)
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      return response.end();
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readBody(request);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const thread = isJson(body.thread) ? body.thread : undefined;
      let base: {
        system: unknown;
        tools: unknown;
        messages: readonly unknown[];
      } = { system: body.system, tools: body.tools, messages: [] };
      if (thread?.type === "continue") {
        const previous = String(thread.previous_message_id);
        const stored = threads.get(previous);
        if (mock.faults.cpaThreadStateLost) {
          delete mock.faults.cpaThreadStateLost;
          // claude_executor_tool_state.go in CPA 8.0.64, sent before any upstream request.
          return json(response, 404, {
            type: "error",
            error: {
              type: "not_found_error",
              message:
                "No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread.",
            },
          });
        }
        if (mock.faults.threadNotFound || !stored) {
          delete mock.faults.threadNotFound;
          return threadError(response, "thread_not_found");
        }
        // A reply can be continued once.
        threads.delete(previous);
        base = stored;
      }
      const merged = [...base.messages, ...messages];
      mock.requests.push({
        transport: "anthropic",
        delta: thread?.type === "continue",
        merged,
        body,
        path: url.pathname,
        headers: request.headers,
      });
      const reply = options.reply(merged, { ...body, system: base.system });
      const id = `msg_a${++replies}`;
      const text = reply.text ?? "";
      if (thread) {
        threads.set(id, {
          system: base.system,
          tools: base.tools,
          messages: [
            ...merged,
            { role: "assistant", content: [{ type: "text", text }] },
          ],
        });
      }
      const model = mock.faults.fallbackModel ?? String(body.model);
      delete mock.faults.fallbackModel;
      response.writeHead(200, { "content-type": "text/event-stream" });
      return response.end(anthropicEvents(id, model, text));
    }
    json(response, 404, { error: { message: `no route ${url.pathname}` } });
  });

  const wss = new NodeWS.WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const status =
      mock.faults.rejectUpgrade ?? (authorized(request) ? undefined : 401);
    if (url.pathname !== "/v1/responses" || status !== undefined) {
      socket.end(
        `HTTP/1.1 ${status ?? 404} Rejected\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = ++mock.connections;
      let last:
        | { input: readonly unknown[]; output: readonly unknown[]; id: string }
        | undefined;
      ws.on("message", (data) => {
        const parsed: unknown = JSON.parse(data.toString());
        if (!isJson(parsed) || parsed.type !== "response.create") return;
        const { type: _type, previous_response_id: previous, ...body } = parsed;
        const input = Array.isArray(body.input) ? body.input : [];
        if (mock.faults.closeAfterRequest !== undefined) {
          const code = mock.faults.closeAfterRequest;
          delete mock.faults.closeAfterRequest;
          ws.close(
            code,
            code === 1012 ? "upstream requires HTTP replay" : "test close",
          );
          return;
        }
        if (mock.faults.stall) {
          delete mock.faults.stall;
          return;
        }
        let merged: readonly unknown[];
        if (typeof previous === "string") {
          if (!last || previous !== last.id || mock.faults.forgetContinuation) {
            delete mock.faults.forgetContinuation;
            ws.send(
              JSON.stringify({
                type: "error",
                status: 409,
                error: {
                  type: "invalid_request_error",
                  code: "previous_response_not_found",
                  message:
                    "Previous response is not available on this websocket",
                },
              }),
            );
            return;
          }
          merged = [...last.input, ...last.output, ...input];
        } else {
          merged =
            last && !hasHistory(input)
              ? [...last.input, ...last.output, ...input]
              : input;
        }
        mock.requests.push({
          transport: "websocket",
          connection,
          delta: typeof previous === "string",
          merged,
          body,
          path: url.pathname,
        });
        const { events, output, id } = responseEvents(
          options.reply(merged, body),
        );
        const dropCode = mock.faults.closeBeforeCompleted;
        if (dropCode !== undefined) {
          delete mock.faults.closeBeforeCompleted;
          const partial = events.slice(0, -1);
          partial.forEach((event, index) =>
            ws.send(JSON.stringify(event), () => {
              if (index < partial.length - 1) return;
              // No close frame carries 1006: clients report it when the connection just ends.
              // Waiting for the last write keeps the drop from discarding buffered events.
              if (dropCode === 1006) ws.terminate();
              else ws.close(dropCode, "test close");
            }),
          );
          return;
        }
        for (const event of events) ws.send(JSON.stringify(event));
        last = { input: merged, output, id };
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return Object.assign(mock, {
    root: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
