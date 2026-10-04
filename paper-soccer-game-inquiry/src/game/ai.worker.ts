import { runAiTask } from "./ai-task";
import type { AiRequest, AiResponse } from "./ai-protocol";

// A narrow worker scope avoids importing lib.webworker into the DOM project's
// global type namespace. This file is emitted as its own worker entry point.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<AiRequest>) => void) | null;
  postMessage(message: AiResponse): void;
};

scope.onmessage = (event) => {
  scope.postMessage(runAiTask(event.data));
};
