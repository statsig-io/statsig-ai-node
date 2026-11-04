> ⚠️ **Beta Notice**
>
> This SDK is currently in **beta**. All APIs are **experimental** and subject to change.
> Please review the [release notes](https://github.com/statsig-io/statsig-ai-node/releases) for any **breaking changes** before upgrading.

## Statsig Node AI SDK

Statsig is the on-stop data platform for product development. We help you move faster with feature gates (feature flags), experiments, and the world's most powerful stats engine. If you're new to Statsig, check out our product and create an account at [statsig.com](https://www.statsig.com/?ref=gh_ai).

The AI SDK provides convenient hooks for developers working with LLMs to iterate on their promps, run evals to test their efficacy, add observability to LLM usage.

<h1 align="center">
	<a href="https://statsig.com/?ref=gh_ai">
		<img src="https://github.com/statsig-io/js-client-monorepo/assets/95646168/ae5499ed-20ff-4584-bf21-8857f800d485" />
	</a>
    <div />
	<a href="https://statsig.com/?ref=gh_ai">Statsig</a>
</h1>

<p align="center">
	<a href="https://github.com/statsig-io/statsig-ai-node/blob/main/LICENSE">
        	<img src="https://img.shields.io/badge/license-ISC-blue.svg?colorA=1b2528&colorB=ccfbc7&style=for-the-badge">
    	</a>
	<a href="https://www.npmjs.com/package/@statsig/statsig-ai">
        	<img src="https://img.shields.io/npm/v/@statsig/statsig-ai.svg?colorA=1b2528&colorB=b2d3ff&style=for-the-badge">
    	</a>
	<a href="https://statsig.com/community?ref=gh_ai">
        	<img src="https://img.shields.io/badge/slack-statsig-brightgreen.svg?logo=slack&colorA=1b2528&colorB=FFF8BA&style=for-the-badge">
    	</a>
</p>

## Getting Started

Read through the [Documentation](https://docs.statsig.com/ai-evals/node?ref=gh_ai) to see code samples and how to get started.

## Tracing model calls

Wrap your provider client to record each model call as an OpenTelemetry span. Calls made inside `prompt.withLive(...)` are tagged with the prompt name, version name and version ID.

```ts
import { wrapAnthropic, wrapGemini, wrapOpenAI } from '@statsig/statsig-ai';

const openai = wrapOpenAI(new OpenAI());
const anthropic = wrapAnthropic(new Anthropic()); // messages.create (incl. stream: true) and messages.stream()
const gemini = wrapGemini(new GoogleGenAI({})); // models.generateContent / generateContentStream
```

Messages are only recorded when you opt in with `captureOptions` (for example `{ captureOptions: { capture_all: true } }`). All wrappers record `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions` in the [OpenTelemetry GenAI message format](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/) (`role` + `parts` such as `text`, `tool_call` and `tool_call_response`).

### Tagging calls with a prompt version

Run the code that renders and sends a prompt inside `prompt.withLive(...)`, or `prompt.withVersion(version, ...)` for a Candidate. Wrapped model calls and `wrap` spans inside it get `statsig.llm.prompt_name`, `statsig.llm.prompt_version` and `statsig.llm.prompt_version_id`, which Statsig uses to attribute online eval grades to a version.

The variables you pass to `getPromptMessages` are recorded as `statsig.llm.prompt_template_variables` (JSON), so the request can be re-run on another version. Model call spans only record them when input capture is on (`capture_all` or `capture_input_messages`). Workflow spans record the variables rendered inside them, so start the workflow inside the version scope.

```ts
const prompt = ai.getPrompt(user, 'support_bot');

const runTurn = wrap({ type: 'workflow', name: 'support_turn' }, (version) =>
  openai.chat.completions.create({
    model: version.getModel(),
    messages: version.getPromptMessages({ input }),
  }),
);

await prompt.withLive(runTurn);
```

### Marking the environment

The `environment` option of `initializeTracing` (defaults to `NODE_ENV`) is recorded on the resource as `deployment.environment.name`. To tag only some spans, for example evals running in the same process as production code, run that code inside `withStatsigEnvironment`. Spans started inside it get a `statsig.environment` attribute, which overrides the resource value for those spans.

Use `production` for live traffic. `eval` and `online_eval_judge` are reserved for spans Statsig generates: `Eval()` runs its tasks and scorers with `statsig.environment=eval`.

```ts
initializeTracing({ environment: 'production' });

await withStatsigEnvironment('staging_canary', () => handleRequest(req));
```

### Joining a Statsig eval trace

A workflow eval sends each dataset row to your endpoint as a POST request. To show your agent's tool and model calls under the eval row in the trace drawer, run the handler inside `withIncomingTraceContext`. It reads the W3C `traceparent` and `tracestate` request headers, so wrapped model calls and `wrap` spans become children of the eval row's span. It accepts Node request headers (`req.headers`) or a Fetch `Headers` object. If there's no valid `traceparent`, the handler runs as usual.

```ts
import { withIncomingTraceContext } from '@statsig/statsig-ai';

// Node / Express
app.post('/agent', (req, res) =>
  withIncomingTraceContext(req.headers, async () => {
    res.json({ output: await runAgent(req.body) });
  }),
);

// Fetch-style handlers (Next.js route handlers, Hono, ...)
export async function POST(request: Request) {
  return withIncomingTraceContext(request.headers, async () =>
    Response.json({ output: await runAgent(await request.json()) }),
  );
}
```

If your server already uses OpenTelemetry HTTP instrumentation, its spans join the trace on their own. The helper keeps the active span when it's already in the incoming trace, so using both is safe.

What Statsig sends today: workflow eval requests carry `Content-Type: application/json` and the headers you configured for the workflow. They don't carry `traceparent` yet. Until they do, `withIncomingTraceContext` leaves your handler unchanged. Statsig also doesn't send a header that marks a request as an eval or shadow run. To tell eval requests apart, for example to skip side effects or to tag their spans with `withStatsigEnvironment('eval', ...)`, add your own header to the workflow's headers and check for it in your handler.

## Community

If you need any assistance or just have a question, feel free to reach out to us on [Slack](https://statsig.com/community?ref=gh_jsm).
