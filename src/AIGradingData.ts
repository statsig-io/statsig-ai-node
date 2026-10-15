export type AIEvalGradeData = {
  sessionId?: string;
  activityId?: string;
  // Defaults to the active OTel span. Set these when grading after the call's span has ended.
  traceId?: string;
  spanId?: string;
  reasoning?: string;
  metadata?: Record<string, string>;
};
