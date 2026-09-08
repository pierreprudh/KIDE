type SidePanelState = {
  hidden: boolean;
  planVisible: boolean;
  questionVisible: boolean;
  resultVisible: boolean;
  width: number;
};

/** Space reserved beside the conversation for the currently visible cards. */
export function sidePanelInset(state: SidePanelState): number {
  const hidden = state.hidden && !state.questionVisible;
  const cards = state.planVisible || state.questionVisible || state.resultVisible;
  return !hidden && cards ? state.width + 36
    : state.planVisible || state.resultVisible ? 76 : 0;
}
