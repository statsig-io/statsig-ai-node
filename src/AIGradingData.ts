type AlEvalGradeDataBase = {
  sessionId?: string;
};

export type AIEvalGradeData = AlEvalGradeDataBase &
  (
    | { usePrimaryGrader: true; graderName?: never }
    | { usePrimaryGrader?: never | false; graderName: string }
  );
