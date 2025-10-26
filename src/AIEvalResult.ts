type AIEvalDataBase = {
  sessionId?: string;
};

export type AIEvalData = AIEvalDataBase &
  (
    | { usePrimaryGrader: boolean; graderName?: string }
    | { usePrimaryGrader?: boolean; graderName: string }
  );
