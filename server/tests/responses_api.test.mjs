import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startPandawaServer } from "./helpers/e2e_harness.mjs";

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Real OpenAI Responses API (/v1/responses) HTTP + SSE protocol server.
 * Intentionally returns HTTP 400 on /chat/completions to guarantee Pandawa routes strictly to /responses.
 */
async function startLocalResponsesServer() {
  const requests = [];
  let forceErrorStatus = 0;
  let forceErrorMessage = "";

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || "/", "http://127.0.0.1");
    const rawBody = await readHttpBody(req);

    if (req.method === "GET" && urlObj.pathname === "/v1/models") {
      sendJson(res, 200, { object: "list", data: [{ id: "gpt-4.1" }, { id: "o3" }] });
      return;
    }

    if (urlObj.pathname.endsWith("/chat/completions")) {
      sendJson(res, 400, { error: { message: "Chat Completions disabled; use /v1/responses" } });
      return;
    }

    if (req.method === "POST" && urlObj.pathname === "/v1/responses") {
      const body = rawBody ? JSON.parse(rawBody) : {};
      requests.push({ path: urlObj.pathname, auth: req.headers.authorization || "", body });

      if (forceErrorStatus >= 400) {
        sendJson(res, forceErrorStatus, {
          error: { message: forceErrorMessage || "Simulated responses API error", code: "bad_responses_req" },
        });
        return;
      }

      if (!body.stream) {
        assert.ok(Array.isArray(body.input), "Responses API payload must include input[]");
        assert.ok(Number(body.max_output_tokens) >= 16, "Responses API max_output_tokens must be >= 16");
        sendJson(res, 200, {
          id: "resp_sync_1",
          status: "completed",
          output_text: "OK-RESPONSES",
          output: [{ type: "message", content: [{ type: "output_text", text: "OK-RESPONSES" }] }],
          usage: { input_tokens: 12, output_tokens: 4 },
        });
        return;
      }

      // SSE streaming multi-step tool loop
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const inputItems = Array.isArray(body.input) ? body.input : [];
      const hasToolOutput = inputItems.some((item) => item?.type === "function_call_output");

      if (!hasToolOutput) {
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const pickedTool =
          tools.find((t) => String(t?.name || "").includes("brain_list"))?.name ||
          tools[0]?.name ||
          "brain_list";

        res.write(
          `event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            item: {
              id: "fc_item_1",
              call_id: "call_resp_1",
              type: "function_call",
              name: pickedTool,
              arguments: "",
            },
          })}\n\n`
        );
        res.write(
          `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
            type: "response.function_call_arguments.delta",
            item_id: "fc_item_1",
            delta: "{}",
          })}\n\n`
        );
        res.write(
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            item: {
              id: "fc_item_1",
              call_id: "call_resp_1",
              type: "function_call",
              name: pickedTool,
              arguments: "{}",
            },
          })}\n\n`
        );
        res.write(
          `event: response.completed\ndata: ${JSON.stringify({
            type: "response.completed",
            response: { id: "resp_stream_1", usage: { input_tokens: 20, output_tokens: 8 } },
          })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "Responses ",
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "ToolVerified!",
        })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { id: "resp_stream_2", usage: { input_tokens: 35, output_tokens: 6 } },
        })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    sendJson(res, 404, { error: `Unhandled responses path ${urlObj.pathname}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setError(status, message) {
      forceErrorStatus = status;
      forceErrorMessage = message;
    },
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test("OpenAI Responses API (openai_responses): non-stream probe, SSE streaming, multi-step tool loop, encryption & OAuth removal check", async () => {
  const respSrv = await startLocalResponsesServer();
  const srv = await startPandawaServer();
  const ws = await srv.connectWs();

  try {
    // 1. Confirm removed OAuth routes return 404 JSON
    const removedOauth = await srv.api("GET", "/api/oauth/presets");
    assert.equal(removedOauth.status, 404);

    // 2. Create Custom Gateway / Responses provider with encrypted API key
    const createProv = await srv.api("POST", "/api/providers", {
      name: "ResponsesProv",
      kind: "openai_responses",
      baseUrl: `${respSrv.baseUrl}/v1`,
      apiKey: "sk-resp-test-secret",
      defaultModel: "gpt-4.1",
      models: ["gpt-4.1", "o3"],
    });
    assert.equal(createProv.status, 200, createProv.text);
    const prov = createProv.data.provider;
    assert.equal(prov.kind, "openai_responses");
    assert.equal(prov.encryptedAtRest, true);
    assert.equal(prov.hasApiKey, true);
    assert.ok(!JSON.stringify(prov).includes("sk-resp-test-secret"));

    // 3. Direct provider /test hits /v1/responses cleanly
    const testRes = await srv.api("POST", `/api/providers/${prov.id}/test`);
    assert.equal(testRes.status, 200);
    assert.equal(testRes.data.ok, true, testRes.text);
    assert.ok(testRes.data.message.includes("OK-RESPONSES"));
    assert.deepEqual(testRes.data.discoveredModels, ["gpt-4.1", "o3"]);

    // 4. Real agent turn exercises SSE streaming + function_call -> function_call_output loop
    const agentRes = await srv.api("POST", "/api/agents", {
      name: "ResponsesAgent",
      title: "Responses Protocol Tester",
      provider_id: prov.id,
      model: "gpt-4.1",
      purpose: "coding",
      system_prompt: "Verify OpenAI Responses API tool calls.",
      toolPacks: ["brain"],
    });
    assert.equal(agentRes.status, 200, agentRes.text);

    const chatRes = await srv.api("POST", "/api/chat/send", {
      targetType: "agent",
      targetId: agentRes.data.id,
      prompt: "List brain files via Responses API tools",
    });
    assert.equal(chatRes.status, 200, chatRes.text);
    assert.ok(
      String(chatRes.data.result.content || "").includes("Responses ToolVerified!"),
      `Expected streamed tool-verified reply, got: ${JSON.stringify(chatRes.data)}`
    );

    const streamReqs = respSrv.requests.filter((r) => r.body?.stream === true);
    assert.equal(streamReqs.length, 2, `Expected 2 SSE turns (tool call + final), got ${streamReqs.length}`);
    assert.ok(typeof streamReqs[0].body.instructions === "string" && streamReqs[0].body.instructions.length > 0);
    assert.ok(Array.isArray(streamReqs[0].body.tools) && streamReqs[0].body.tools.length > 0);
    assert.ok(
      streamReqs[1].body.input.some((i) => i?.type === "function_call" && i?.call_id === "call_resp_1"),
      "Second turn input missing function_call item"
    );
    assert.ok(
      streamReqs[1].body.input.some((i) => i?.type === "function_call_output" && i?.call_id === "call_resp_1"),
      "Second turn input missing function_call_output item"
    );

    // 5. Error wrapping includes [ProviderName | model]
    respSrv.setError(400, "Simulated responses API rejection");
    const errTest = await srv.api("POST", `/api/providers/${prov.id}/test`);
    assert.equal(errTest.status, 200);
    assert.equal(errTest.data.ok, false);
    assert.ok(errTest.data.message.includes("[ResponsesProv | gpt-4.1]"), errTest.data.message);
    assert.ok(errTest.data.message.includes("Simulated responses API rejection"), errTest.data.message);
  } finally {
    try { ws.close(); } catch {}
    await srv.stop().catch(() => {});
    await respSrv.close().catch(() => {});
  }
});
