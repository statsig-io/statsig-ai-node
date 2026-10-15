import { Context } from '@opentelemetry/api';
import { BatchSpanProcessor, Span } from '@opentelemetry/sdk-trace-base';
import { getEnvironmentSpanAttrsFromContext } from './environment-context';
import { getUserSpanAttrsFromContext } from './user-context';

export class StatsigSpanProcessor extends BatchSpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    const statsigUserAttrs = getUserSpanAttrsFromContext(parentContext);
    if (statsigUserAttrs) {
      span.setAttributes(statsigUserAttrs);
    }

    const environmentAttrs = getEnvironmentSpanAttrsFromContext(parentContext);
    if (environmentAttrs) {
      span.setAttributes(environmentAttrs);
    }

    super.onStart(span, parentContext);
  }
}
