import { Context } from '@opentelemetry/api';
import { BatchSpanProcessor, Span } from '@opentelemetry/sdk-trace-base';
import { getUserSpanAttrsFromContext } from './user-context';

export class StatsigSpanProcessor extends BatchSpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const statsigUserAttrs = getUserSpanAttrsFromContext(parentContext);
    if (statsigUserAttrs) {
      span.setAttributes(statsigUserAttrs);
    }

    super.onStart(span, parentContext);
  }
}
