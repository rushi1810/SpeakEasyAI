import Groq from 'groq-sdk';

import { GroqModelCatalog } from './ModelSettings';
import { ModelRegistry, modelRegistry } from './ModelRegistry';

export class GroqProvider {
  constructor(
    private readonly getClient: () => Groq,
    private readonly registry: ModelRegistry = modelRegistry
  ) {}

  async refreshModels(): Promise<GroqModelCatalog> {
    const response = await this.getClient().models.list();
    return this.registry.setModels(response.data, 'groq');
  }
}
