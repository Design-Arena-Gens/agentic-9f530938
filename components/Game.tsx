"use client";
import { useCallback, useMemo, useState } from 'react';
import BubbleShooterCanvas from './BubbleShooterCanvas';
import { LEVELS } from '../lib/levels';
import type { GameStats, LevelConfig } from '../lib/types';
import { playWin } from '../lib/audio';

export default function Game() {
  const [levelIndex, setLevelIndex] = useState(0);
  const [lives, setLives] = useState(3);
  const [stats, setStats] = useState<GameStats>({ score: 0, shots: 0, combos: 0 });
  const [runningKey, setRunningKey] = useState(0);
  const [muted, setMuted] = useState(false);

  const level: LevelConfig = useMemo(() => LEVELS[levelIndex], [levelIndex]);

  const handleLevelWin = useCallback((levelScore: number) => {
    setStats(s => ({ ...s, score: s.score + levelScore }));
    playWin();
    setTimeout(() => {
      if (levelIndex < LEVELS.length - 1) {
        setLevelIndex(levelIndex + 1);
        setLives(3);
        setRunningKey(k => k + 1);
      } else {
        // Restart after final level
        setLevelIndex(0);
        setLives(3);
        setRunningKey(k => k + 1);
      }
    }, 800);
  }, [levelIndex]);

  const handleLoseLife = useCallback(() => {
    setLives(l => {
      const next = l - 1;
      if (next <= 0) {
        // reset level with score penalty
        setRunningKey(k => k + 1);
        return 3;
      }
      return next;
    });
  }, []);

  const handleShot = useCallback(() => setStats(s => ({ ...s, shots: s.shots + 1 })), []);
  const handleCombo = useCallback(() => setStats(s => ({ ...s, combos: s.combos + 1 })), []);

  const restartLevel = () => setRunningKey(k => k + 1);

  const accuracy = stats.shots > 0 ? Math.round(((stats.shots - Math.max(0, stats.shots - stats.combos * 2)) / stats.shots) * 100) : 100;

  return (
    <div className="container">
      <div className="header">
        <div className="title">Color Burst: Bubble Shooter</div>
        <div className="controls">
          <div className="stat">Level: <strong>{level.level} / {LEVELS.length}</strong></div>
          <div className="stat">Difficulty: <strong>{level.difficulty}</strong></div>
          <div className="stat">Lives: <strong>{lives}</strong></div>
          <div className="stat">Score: <strong>{stats.score}</strong></div>
          <button className="button secondary" onClick={restartLevel}>Restart Level</button>
          <button className="button" onClick={() => setLevelIndex(i => Math.max(0, Math.min(LEVELS.length - 1, i + 1)))}>Skip ?</button>
          <button className="button" onClick={() => setMuted(m => !m)}>{muted ? 'Unmute' : 'Mute'}</button>
        </div>
      </div>

      <div className="card">
        <div className="canvasWrap">
          <BubbleShooterCanvas
            key={runningKey}
            level={level}
            lives={lives}
            muted={muted}
            onWin={handleLevelWin}
            onLoseLife={handleLoseLife}
            onShot={handleShot}
            onCombo={handleCombo}
          />
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div className="stat">Shots: <strong>{stats.shots}</strong></div>
        <div className="stat">Combos: <strong>{stats.combos}</strong></div>
        <div className="stat">Accuracy: <strong>{accuracy}%</strong></div>
      </div>
    </div>
  );
}
