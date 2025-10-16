import { OpenAI } from 'openai';

/**
 * Default responses for mock OpenAI client.
 * Exported so tests can import them directly to assert against.
 */
export const DefaultMockResponses = {
  chatCompletion: {
    id: 'cmpl-mock',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'This is a mock chat response' },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    },
  },

  textCompletion: {
    id: 'cmpl-mock',
    object: 'text_completion',
    created: Date.now(),
    model: 'gpt-3.5-turbo-instruct',
    choices: [
      {
        text: 'This is a mock text completion',
        index: 0,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    },
  },

  embedding: {
    object: 'list',
    data: [
      {
        object: 'embedding',
        embedding: Array(1536).fill(0.01),
        index: 0,
      },
    ],
    model: 'text-embedding-ada-002',
    usage: {
      prompt_tokens: 10,
      total_tokens: 10,
    },
  },

  image: {
    created: Date.now(),
    data: [{ url: 'https://example.com/mock-image.png' }],
  },

  moderation: {
    id: 'modr-mock',
    model: 'text-moderation-007',
    results: [
      {
        flagged: false,
        categories: {
          sexual: false,
          hate: false,
          harassment: false,
          'self-harm': false,
          'sexual/minors': false,
          'hate/threatening': false,
          'violence/graphic': false,
          'self-harm/intent': false,
          'self-harm/instructions': false,
          'harassment/threatening': false,
          violence: false,
        },
        category_scores: {
          sexual: 0.0,
          hate: 0.0,
          harassment: 0.0,
          'self-harm': 0.0,
          'sexual/minors': 0.0,
          'hate/threatening': 0.0,
          'violence/graphic': 0.0,
          'self-harm/intent': 0.0,
          'self-harm/instructions': 0.0,
          'harassment/threatening': 0.0,
          violence: 0.0,
        },
      },
    ],
  },
};

/**
 * Mock OpenAI client with overridable jest.fn() methods.
 */
export class MockOpenAI implements Partial<OpenAI> {
  public chat: any;
  public completions: any;
  public embeddings: any;
  public images: any;
  public moderations: any;

  constructor() {
    this.chat = {
      completions: {
        create: jest
          .fn()
          .mockResolvedValue(DefaultMockResponses.chatCompletion),
      },
    };

    this.completions = {
      create: jest.fn().mockResolvedValue(DefaultMockResponses.textCompletion),
    };

    this.embeddings = {
      create: jest.fn().mockResolvedValue(DefaultMockResponses.embedding),
    };

    this.images = {
      generate: jest.fn().mockResolvedValue(DefaultMockResponses.image),
    };

    this.moderations = {
      create: jest.fn().mockResolvedValue(DefaultMockResponses.moderation),
    };
  }
}
