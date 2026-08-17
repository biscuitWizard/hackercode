#!/usr/bin/env node
/**
 * OpenAI-compatible /v1/chat/completions with tool calling.
 *
 * Used to drive the HackerCode agent loop end-to-end without a paid key.
 * Scripted, not a model: it inspects the conversation and returns the next
 * tool call or the closing reply. Also speaks the Claude-via-OpenRouter
 * dialect (empty content + reasoning + tool_calls) so that path is tested.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_LLM_PORT || 8740);
const HOST = process.env.MOCK_LLM_HOST || '0.0.0.0';

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function sse(res, events) {
	res.writeHead(200, {
		'content-type': 'text/event-stream',
		'cache-control': 'no-cache',
		connection: 'keep-alive'
	});
	for (const event of events) {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	}
	res.write('data: [DONE]\n\n');
	res.end();
}

function textDelta(content) {
	return { choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

function reasoningDelta(reasoning) {
	return { choices: [{ index: 0, delta: { reasoning, content: null }, finish_reason: null }] };
}

function toolCall(id, name, args) {
	return {
		choices: [{
			index: 0,
			delta: {
				content: null,
				tool_calls: [{
					index: 0,
					id,
					type: 'function',
					function: { name, arguments: JSON.stringify(args) }
				}]
			},
			finish_reason: 'tool_calls'
		}]
	};
}

function stop() {
	return { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
}

function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'user') {
			continue;
		}
		if (typeof message.content === 'string') {
			return message.content;
		}
		if (Array.isArray(message.content)) {
			return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
		}
	}
	return '';
}

function hasImage(messages) {
	return messages.some(message =>
		Array.isArray(message.content) && message.content.some(part => part.type === 'image_url' || part.type === 'image'));
}

function toolResults(messages) {
	return messages.filter(message => message.role === 'tool').map(message => ({
		id: message.tool_call_id,
		content: String(message.content ?? '')
	}));
}

function assistantToolNames(messages) {
	const names = [];
	for (const message of messages) {
		if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
			for (const call of message.tool_calls) {
				names.push(call.function?.name);
			}
		}
	}
	return names;
}

function decide(payload) {
	const messages = payload.messages ?? [];
	const user = lastUserText(messages);
	const results = toolResults(messages);
	const called = assistantToolNames(messages);
	const tools = new Set((payload.tools ?? []).map(tool => tool.function?.name));

	if (hasImage(messages) && /image|picture|screenshot|what do you see/i.test(user)) {
		return [textDelta('SAW_IMAGE'), stop()];
	}

	if (/^\s*say hi\b/i.test(user) || /\bHELLO_ONLY\b/.test(user)) {
		return [textDelta('HELLO_OK'), stop()];
	}

	// Core loop: list → create → reply. Uses the Claude dialect on the first
	// tool call (reasoning, no content) so that path cannot regress.
	if (/\bCORE_LOOP\b/.test(user) || /create (a )?notes\.txt/i.test(user) || /write hello/i.test(user)) {
		if (!called.includes('list_dir') && tools.has('list_dir')) {
			return [
				reasoningDelta('I will look at the workspace, then write notes.txt.'),
				toolCall('call_list', 'list_dir', { path: '.' })
			];
		}
		if (!called.includes('create_file') && tools.has('create_file')) {
			return [toolCall('call_create', 'create_file', {
				path: 'notes.txt',
				content: 'hello from the agent loop\n'
			})];
		}
		const created = results.some(result => /created|replaced|already has/i.test(result.content));
		return [textDelta(created ? 'CORE_LOOP_DONE: wrote notes.txt' : 'CORE_LOOP_DONE: attempted notes.txt'), stop()];
	}

	if (results.length > 0) {
		const last = results[results.length - 1];
		return [textDelta(`I used a tool. Last result: ${last.content.slice(0, 200)}`), stop()];
	}

	if (tools.has('list_dir') && /what files|list (the )?(dir|folder|workspace)|look around/i.test(user)) {
		return [toolCall('call_list', 'list_dir', { path: '.' })];
	}

	return [textDelta(`I heard: ${user.slice(0, 200) || '(empty)'}`), stop()];
}

const server = http.createServer(async (req, res) => {
	res.setHeader('access-control-allow-origin', '*');
	res.setHeader('access-control-allow-headers', '*');
	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	if (req.url === '/v1/models' || req.url === '/models') {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ data: [{ id: 'mock-agent' }] }));
		return;
	}

	if (req.method === 'POST' && /\/chat\/completions$/.test(req.url ?? '')) {
		let payload = {};
		try {
			payload = JSON.parse(await readBody(req));
		} catch {
			res.writeHead(400, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'invalid json' } }));
			return;
		}
		console.log(`[mock-llm] tools=${(payload.tools ?? []).map(t => t.function?.name).join(',') || '(none)'} messages=${(payload.messages ?? []).length}`);
		sse(res, decide(payload));
		return;
	}

	res.writeHead(404, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
});

server.listen(PORT, HOST, () => {
	console.log(`[mock-llm] listening on http://${HOST}:${PORT}/v1`);
});
