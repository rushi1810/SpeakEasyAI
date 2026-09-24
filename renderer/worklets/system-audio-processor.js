class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputSampleRate = 48000;
    this.outputSampleRate = 16000;
    this.port.onmessage = event => {
      const config = event.data || {};
      if (config.type === 'config') {
        this.inputSampleRate = Number(config.sampleRate) || 48000;
        this.outputSampleRate = Number(config.outputSampleRate) || 16000;
      }
    };
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0];
    if (!input || !input.length) {
      return true;
    }

    const channelCount = input.length;
    const frameLength = input[0].length;
    if (!frameLength) {
      return true;
    }

    const mono = new Float32Array(frameLength);
    for (let i = 0; i < frameLength; i++) {
      let sum = 0;
      for (let channel = 0; channel < channelCount; channel++) {
        sum += input[channel][i] || 0;
      }
      mono[i] = sum / channelCount;
    }

    const resampledLength = Math.max(1, Math.round(frameLength * this.outputSampleRate / this.inputSampleRate));
    const resampled = new Float32Array(resampledLength);

    if (this.inputSampleRate === this.outputSampleRate) {
      resampled.set(mono);
    } else {
      const sampleScale = (mono.length - 1) / Math.max(1, resampledLength - 1);
      for (let i = 0; i < resampledLength; i++) {
        const index = i * sampleScale;
        const left = Math.floor(index);
        const right = Math.min(mono.length - 1, left + 1);
        const weight = index - left;
        const leftSample = mono[left] || 0;
        const rightSample = mono[right] || 0;
        resampled[i] = leftSample + (rightSample - leftSample) * weight;
      }
    }

    const pcm = new Int16Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      const sample = Math.max(-1, Math.min(1, resampled[i]));
      pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }

    const bytes = new Uint8Array(pcm.buffer);
    this.port.postMessage({ type: 'pcm', data: bytes.buffer, sampleCount: resampled.length }, [bytes.buffer]);
    return true;
  }
}

registerProcessor('system-audio-processor', SystemAudioProcessor);
