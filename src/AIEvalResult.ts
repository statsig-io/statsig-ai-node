type AIEvalDataBase = {
  sessionId?: string;
};

export type AIEvalData = AIEvalDataBase &
  (
    | { usePrimaryGrader: true; graderName?: never }
    | { usePrimaryGrader?: never; graderName: string }
  );
