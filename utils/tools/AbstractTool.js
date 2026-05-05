export class AbstractTool {
  name = ''

  parameters = {}

  description = ''

  /** Skip the second model pass when the tool action is already user-visible. */
  skipModelResponse = false

  func = async function () {}

  shouldSkipModelResponse () {
    return this.skipModelResponse
  }

  function () {
    if (!this.parameters.type) {
      this.parameters.type = 'object'
    }
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters
    }
  }
}
