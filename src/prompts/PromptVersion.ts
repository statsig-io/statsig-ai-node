import { DynamicConfig } from '@statsig/statsig-node-core';

export type PromptParams = {
  [key: string]: any;
};

export type PromptMessage = {
  role: string;
  content: string;
};

export class PromptVersion {
  public readonly name: string;
  private _promptVariant: DynamicConfig;
  private _id: string;
  private _temperature: number;
  private _maxTokens: number;
  private _topP: number;
  private _frequencyPenalty: number;
  private _presencePenalty: number;
  private _provider: string;
  private _model: string;
  private _workflowBody: Record<string, any>;
  private _evalModel: string;
  private _type: string;
  private _aiConfigName: string;

  constructor(promptVariant: DynamicConfig) {
    this.name = promptVariant.getValue('name', '');
    this._type = promptVariant.getValue('type', '');
    this._aiConfigName = promptVariant.getValue('aiConfigName', '');
    const parts = promptVariant.name.split(':');
    this._id = parts.length > 1 ? parts[1] : '';

    this._promptVariant = promptVariant;
    this._temperature = promptVariant.getValue('temperature', null);
    this._maxTokens = promptVariant.getValue('maxTokens', null);
    this._topP = promptVariant.getValue('topP', null);
    this._frequencyPenalty = promptVariant.getValue('frequencyPenalty', null);
    this._presencePenalty = promptVariant.getValue('presencePenalty', null);
    this._provider = promptVariant.getValue('provider', null);
    this._model = promptVariant.getValue('model', null);
    this._workflowBody = promptVariant.getValue('workflowBody', null);
    this._evalModel = promptVariant.getValue('evalModel', null);
  }

  getName(): string {
    return this.name;
  }

  getID(): string {
    return this._id;
  }

  getType(): string {
    return this._type;
  }

  getPromptName(): string {
    return this._aiConfigName;
  }

  getTemperature(options?: { fallback: number }): number {
    return this._temperature ?? options?.fallback ?? 0;
  }

  getMaxTokens(options?: { fallback: number }): number {
    return this._maxTokens ?? options?.fallback ?? 0;
  }

  getTopP(options?: { fallback: number }): number {
    return this._topP ?? options?.fallback ?? 0;
  }

  getFrequencyPenalty(options?: { fallback: number }): number {
    return this._frequencyPenalty ?? options?.fallback ?? 0;
  }

  getPresencePenalty(options?: { fallback: number }): number {
    return this._presencePenalty ?? options?.fallback ?? 0;
  }

  getProvider(options?: { fallback: string }): string {
    return this._provider || options?.fallback || '';
  }

  getModel(options?: { fallback: string }): string {
    return this._model || options?.fallback || '';
  }

  getWorkflowBody(options?: {
    fallback: Record<string, any>;
  }): Record<string, any> {
    return this._workflowBody ?? options?.fallback ?? {};
  }

  getEvalModel(options?: { fallback: string }): string {
    return this._evalModel || options?.fallback || '';
  }

  getValue(
    key: string,
    fallback: boolean | number | string | object | Array<any> | null,
  ): any {
    const value = this._promptVariant.getValue(key, fallback);
    return value;
  }

  getPromptMessages(params: PromptParams): PromptMessage[] {
    const prompts = this._promptVariant.getValue('prompts', [
      { role: 'system', content: '' },
    ]);

    const regex = /{{\s*([^}]+)\s*}}/g; // matches {{ anything.inside.braces }}

    // Resolve nested object paths (supports array indices)
    return prompts.map((p: { role: string; content: string }) => ({
      role: p.role,
      content: p.content.replace(regex, (_, path) => {
        const value = resolvePath(params, path.trim());
        return value !== undefined ? String(value) : `{{${path}}}`;
      }),
    }));
  }
}

function resolvePath(obj: any, path: string): any {
  const parts = path
    // convert [0] to .0 so we can split cleanly
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.');

  return parts.reduce((acc, key) => {
    if (acc && key in acc) {
      return acc[key];
    }
    return undefined;
  }, obj);
}
