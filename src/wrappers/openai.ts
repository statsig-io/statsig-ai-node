export function wrapOpenAI<T extends object>(openai: T): T {
  return openai;
}
