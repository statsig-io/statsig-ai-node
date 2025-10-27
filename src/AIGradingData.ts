type AIGradingDataBase = {
  sessionId?: string;
};

export type AiGradingData = AIGradingDataBase &
  (
    | { usePrimaryGrader: true; graderName?: never }
    | { usePrimaryGrader?: never | false; graderName: string }
  );
