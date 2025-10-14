import { DynamicConfig } from '@statsig/statsig-node-core';

export type PromptParams = {
  [key: string]: any;
};

export type PromptMessage = {
  role: string;
  content: string;
};

export class PromptVersion {
  public name: string;

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

    this._promptVariant = promptVariant;
    this._temperature = promptVariant.getValue('temperature', 0);
    this._maxTokens = promptVariant.getValue('maxTokens', 0);
    this._topP = promptVariant.getValue('topP', 0);
    this._frequencyPenalty = promptVariant.getValue('frequencyPenalty', 0);
    this._presencePenalty = promptVariant.getValue('presencePenalty', 0);
    this._provider = promptVariant.getValue('provider', '');
    this._model = promptVariant.getValue('model', '');
    this._workflowBody = promptVariant.getValue('workflowBody', {});
    this._evalModel = promptVariant.getValue('evalModel', '');
    this._type = promptVariant.getValue('type', '');
    this._aiConfigName = promptVariant.getValue('aiConfigName', '');
    const parts = promptVariant.name.split(':');
    this._id = parts.length > 1 ? parts[1] : '';
  }

  getName(): string {
    return this.name;
  }

  getID(): string {
    return this._id;
  }

  getTemperature(): number {
    return this._temperature;
  }

  getMaxTokens(): number {
    return this._maxTokens;
  }

  getTopP(): number {
    return this._topP;
  }

  getFrequencyPenalty(): number {
    return this._frequencyPenalty;
  }

  getPresencePenalty(): number {
    return this._presencePenalty;
  }

  getProvider(): string {
    return this._provider;
  }

  getModel(): string {
    return this._model;
  }

  getWorkflowBody(): Record<string, any> {
    return this._workflowBody;
  }

  getEvalModel(): string {
    return this._evalModel;
  }

  getType(): string {
    return this._type;
  }

  getAIConfigName(): string {
    return this._aiConfigName;
  }

  getValue(
    key: string,
    fallback: boolean | number | string | object | Array<any> | null,
  ): any {
    const value = this._promptVariant.getValue(key, fallback);
    if (value == null) {
      throw new Error(`Version value for key ${key} is null`);
    }
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
