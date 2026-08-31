/*
  beatdetect.js
  ---------------------------------------------------------
  Deteksi beat otomatis dari AudioBuffer (energy-based onset
  detection). Ini BUKAN algoritma sempurna — dia mendeteksi
  momen di mana energi suara melonjak dibanding rata-rata
  sekitarnya (biasanya kick drum / hentakan bass / drum hit).
  Paling akurat untuk lagu dengan ketukan yang jelas (pop,
  EDM, dance). Untuk lagu yang sangat ambient/lembut, hasil
  bisa lebih jarang.

  Exposes: window.BeatDetect.analyze(audioBuffer, difficulty)
  -> Promise<Array<{ time: number, lane: 'up'|'down'|'left'|'right' }>>
*/
(function () {
  const LANES = ['up', 'left', 'down', 'right'];

  const DIFF_SETTINGS = {
    easy:   { minGap: 0.42, maxDensity: 0.55, sensitivity: 1.0 },
    normal: { minGap: 0.30, maxDensity: 0.75, sensitivity: 1.08 },
    hard:   { minGap: 0.20, maxDensity: 1.0,  sensitivity: 1.18 },
  };

  function getMonoData(buffer) {
    const ch0 = buffer.getChannelData(0);
    if (buffer.numberOfChannels === 1) return ch0;
    const ch1 = buffer.getChannelData(1);
    const out = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) out[i] = (ch0[i] + ch1[i]) / 2;
    return out;
  }

  function computeFrameEnergies(data, frameSize, hopSize) {
    const frames = [];
    for (let i = 0; i + frameSize <= data.length; i += hopSize) {
      let sum = 0;
      for (let j = 0; j < frameSize; j++) {
        const s = data[i + j];
        sum += s * s;
      }
      frames.push(sum / frameSize); // instant energy
    }
    return frames;
  }

  // Classic local-average-energy beat detection with variance-adjusted threshold.
  function detectOnsets(energies, sampleRate, hopSize, sensitivity) {
    const windowFrames = Math.round((1.0 * sampleRate) / hopSize); // ~1 sec history
    const onsets = [];

    for (let i = 0; i < energies.length; i++) {
      const start = Math.max(0, i - windowFrames);
      let sum = 0;
      for (let k = start; k < i; k++) sum += energies[k];
      const count = i - start;
      if (count < 8) continue; // not enough history yet

      const avg = sum / count;
      let variance = 0;
      for (let k = start; k < i; k++) variance += Math.pow(energies[k] - avg, 2);
      variance /= count;

      // Constants adapted from the well-known "sound energy" beat detection approach.
      let C = (-0.0025714 * variance + 1.5142857) * sensitivity;
      C = Math.max(1.05, Math.min(C, 2.6));

      if (avg > 1e-8 && energies[i] > avg * C) {
        onsets.push(i);
      }
    }
    return onsets;
  }

  function framesToTimes(onsetFrames, hopSize, sampleRate) {
    return onsetFrames.map(f => (f * hopSize) / sampleRate);
  }

  function enforceMinGapAndDensity(times, minGap, maxDensity, songDuration) {
    const filtered = [];
    let lastT = -Infinity;
    for (const t of times) {
      if (t - lastT >= minGap) {
        filtered.push(t);
        lastT = t;
      }
    }
    // Cap overall density (notes per second) according to difficulty.
    const maxNotes = Math.floor(songDuration * maxDensity);
    if (filtered.length <= maxNotes || maxNotes <= 0) return filtered;

    const step = filtered.length / maxNotes;
    const capped = [];
    for (let i = 0; i < maxNotes; i++) {
      capped.push(filtered[Math.floor(i * step)]);
    }
    return capped;
  }

  function assignLanes(times) {
    const notes = [];
    let prevLane = -1;
    let prevPrevLane = -2;
    for (let i = 0; i < times.length; i++) {
      let choices = LANES.map((_, idx) => idx).filter(idx => idx !== prevLane);
      // avoid A-B-A-B monotony a little by nudging away from 2-ago lane sometimes
      if (Math.random() < 0.4) {
        choices = choices.filter(idx => idx !== prevPrevLane);
        if (choices.length === 0) choices = LANES.map((_, idx) => idx).filter(idx => idx !== prevLane);
      }
      const lane = choices[Math.floor(Math.random() * choices.length)];
      notes.push({ time: times[i], lane: LANES[lane] });
      prevPrevLane = prevLane;
      prevLane = lane;
    }
    return notes;
  }

  async function analyze(audioBuffer, difficulty) {
    const settings = DIFF_SETTINGS[difficulty] || DIFF_SETTINGS.normal;
    const data = getMonoData(audioBuffer);
    const sampleRate = audioBuffer.sampleRate;

    const frameSize = 1024;
    const hopSize = 512;

    const energies = computeFrameEnergies(data, frameSize, hopSize);
    const onsetFrames = detectOnsets(energies, sampleRate, hopSize, settings.sensitivity);
    let times = framesToTimes(onsetFrames, hopSize, sampleRate);

    // Skip the very first second (avoid notes before player is ready) and
    // leave a little breathing room before the song's audible start.
    times = times.filter(t => t > 1.0);

    times = enforceMinGapAndDensity(times, settings.minGap, settings.maxDensity, audioBuffer.duration);

    const notes = assignLanes(times);
    return notes;
  }

  window.BeatDetect = { analyze };
})();
