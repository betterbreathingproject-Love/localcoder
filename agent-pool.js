'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { LSP_TOOL_SETS } = require('./direct-bridge');

// Memory client — gracefully degrades if unavailable
let memoryClient = null
try {
  memoryClient = require('./memory-client.js')
} catch (_) {}

// Cascade router — optional; enables tier escalation when provided
let CascadeRouter = null
try {
  ({ CascadeRouter } = require('./cascade-router.js'))
} catch (_) { /* cascade routing disabled */ }

// --- Constants ---

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT = 600000; // 10 minutes

/**
 * Category keywords used to match task titles/metadata to subagent types.
 * Each key is a subagent type name, value is an array of keywords.
 */
const CATEGORY_KEYWORDS = {
  'explore': ['explore', 'understand', 'analyze', 'overview', 'structure', 'how does', 'explain', 'investigate', 'audit', 'review'],
  'context-gather': ['context', 'gather', 'find relevant', 'related files', 'dependencies', 'what files', 'identify files'],
  'code-search': ['search', 'find', 'grep', 'locate', 'lookup', 'ast', 'query', 'where is', 'usage', 'references'],
  'requirements': ['requirement', 'requirements', 'spec', 'specification', 'user story', 'acceptance', 'define', 'criteria'],
  'design': ['design', 'architecture', 'diagram', 'interface', 'schema', 'model', 'plan', 'structure', 'layout', 'api design'],
  'debug': ['debug', 'debugg', 'diagnose', 'trace', 'stack trace', 'error', 'exception', 'crash', 'failing', 'broken', 'not working', 'reproduce', 'root cause', 'why is', 'why does', "doesn't work", "not loading", "won't load", "fails to", "not starting"],
  'tester': ['test', 'testing', 'verify', 'check', 'playwright', 'browser test', 'e2e', 'end to end', 'screenshot', 'click', 'navigate', 'ui test', 'visual test', 'does it work', 'validate', 'qa', 'acceptance test', 'xcode test', 'xctest', 'simulator', 'ios test', 'unit test'],
  'implementation': ['implement', 'code', 'build', 'create', 'write', 'develop', 'refactor', 'fix', 'bug', 'add', 'update', 'modify', 'change', 'set up', 'configure', 'install', 'upgrade', 'migrate', 'integrate', 'wire', 'connect', 'replace', 'rewrite', 'patch', 'extend', 'enable', 'disable', 'render', 'display', 'handle', 'parse', 'generate', 'emit', 'register', 'xcode', 'swift', 'swiftui', 'xcodebuild', 'cocoapods', 'spm', 'swift package'],
  'game-dev': ['game', 'sprite', 'canvas', 'player', 'enemy', 'collision', 'level', 'tile', 'tilemap', 'animation', 'frame', 'fps', 'game loop', 'physics', 'hitbox', 'power-up', 'powerup', 'bonus', 'score', 'lives', 'health', 'spawn', 'projectile', 'bullet', 'platform', 'platformer', 'mario', 'jump', 'gravity', 'velocity', 'parallax', 'particle', 'explosion', 'boss', 'wave', 'stage', 'world', 'camera scroll', 'viewport', 'spritesheet', 'pixel', 'retro', 'arcade', 'side-scroller', 'top-down', 'rpg', 'inventory', 'quest', 'npc', 'dialogue', 'cutscene', 'game over', 'respawn', 'checkpoint', 'save state', 'high score', 'leaderboard', 'multiplayer', 'lobby', 'matchmaking', 'game state', 'state machine', 'finite state', 'entity', 'component', 'ecs', 'scene', 'renderer', 'webgl', 'pixi', 'phaser', 'three.js', 'godot', 'unity', 'coin', 'coins', 'pipe', 'pipes', 'zone', 'warp', 'teleport', 'portal', 'dungeon', 'maze', 'obstacle', 'hazard', 'lava', 'spike', 'trap', 'shield', 'weapon', 'sword', 'arrow', 'magic', 'mana', 'xp', 'level up', 'skill tree', 'loot', 'drop', 'crafting', 'mining', 'farming', 'tower defense', 'wave defense', 'survival', 'roguelike', 'procedural', 'random generation', 'seed', 'biome', 'terrain', 'pathfinding', 'ai behavior', 'steering', 'flocking', 'a-star', 'navmesh'],
};

// --- AgentPool ---

class AgentPool extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} [options.maxConcurrency=3]
   * @param {number} [options.defaultTimeout=300000]
   * @param {function} [options.agentFactory] - Optional factory for creating agents (for DI/testing)
   * @param {function} [options.getLspStatus] - Callback returning current LSP status string (e.g. 'ready', 'stopped')
   */
  constructor(options = {}) {
    super();
    // Each queued task registers a once('agent-type-selected') listener before acquiring
    // a slot — so N queued tasks = N listeners. Raise the limit to avoid false leak warnings.
    this.setMaxListeners(50);
    this._maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this._defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT;
    this._agentFactory = options.agentFactory || null;
    this._getLspStatus = options.getLspStatus || null;
    this._getCalibrationProfile = options.getCalibrationProfile || null;
    this._safeEditInstructions = options.safeEditInstructions || null;

    // ── Cascade router (opt-in) ─────────────────────────────────────────
    // When enabled, dispatches to fast/mid models first and escalates to
    // primary only when needed. Pass { cascade: { tiers: {...} } } to enable.
    this._cascadeRouter = null;
    if (options.cascade && CascadeRouter) {
      this._cascadeRouter = new CascadeRouter({
        tiers: options.cascade.tiers || {},
        policy: options.cascade.policy,
        confidenceThreshold: options.cascade.confidenceThreshold,
        onEscalate: (info) => this.emit('cascade-escalate', info),
      });
    }

    // Subagent type registry: Map<name, SubagentType>
    this._types = new Map();

    // Semaphore-based concurrency control
    this._activeCount = 0;
    this._waitQueue = []; // Array of { resolve } for queued dispatches

    // Running foreground tasks: Map<taskId, { task, startTime, abortController }>
    this._runningTasks = new Map();

    // Background tasks: Map<taskId, BackgroundTask>
    this._backgroundTasks = new Map();
  }

  // --- Type Registry ---

  /**
   * Register a SubagentType config.
   * @param {object} type - { name, systemPrompt, allowedTools, timeout, maxConcurrent }
   */
  registerType(type) {
    if (!type || !type.name) {
      throw new Error('SubagentType must have a name');
    }
    this._types.set(type.name, {
      name: type.name,
      systemPrompt: type.systemPrompt || '',
      allowedTools: type.allowedTools || [],
      timeout: type.timeout ?? this._defaultTimeout,
      maxConcurrent: type.maxConcurrent ?? this._maxConcurrency,
    });
  }

  /**
   * Set or replace the LSP status getter callback.
   * @param {function} fn - Returns the current LSP status string (e.g. 'ready', 'stopped')
   */
  setLspStatusGetter(fn) {
    this._getLspStatus = typeof fn === 'function' ? fn : null;
  }

  /**
   * Get cascade router stats, or null if cascading is disabled.
   */
  getCascadeStats() {
    return this._cascadeRouter ? this._cascadeRouter.stats() : null;
  }

  /**
   * Get the cascade router instance (for agent factories that want to honor it).
   */
  getCascadeRouter() {
    return this._cascadeRouter;
  }

  /**
   * Get the effective allowed tools for a type, merging LSP tools when LSP is ready.
   * @param {object} typeConfig - The registered SubagentType config
   * @returns {string[]} Merged tool list
   */
  _getEffectiveTools(typeConfig) {
    if (!typeConfig) return [];
    const base = typeConfig.allowedTools || [];
    const lspStatus = typeof this._getLspStatus === 'function' ? this._getLspStatus() : null;
    if (lspStatus !== 'ready') return base;
    const lspTools = LSP_TOOL_SETS[typeConfig.name] || [];
    if (lspTools.length === 0) return base;
    return [...base, ...lspTools];
  }

  // --- Type Selection ---

  /**
   * Select the best subagent type for a task based on category keywords in title/metadata.
   * Returns a copy of the type config with LSP tools merged into allowedTools when LSP is ready.
   * @param {object} task - TaskNode
   * @returns {object|null} SubagentType config (with effective allowedTools) or null
   */
  selectType(task) {
    let matched = null;

    if (!task) {
      matched = this._types.get('general') || null;
    } else {
      // Check explicit metadata category first
      const explicitCategory = task.metadata?.category || task.metadata?.agentType;
      if (explicitCategory && this._types.has(explicitCategory)) {
        matched = this._types.get(explicitCategory);
      } else {
        // Match keywords in title and description
        const titleLower = ((task.title || '') + ' ' + (task.description || '')).toLowerCase();
        let bestMatch = null;
        let bestScore = 0;

        for (const [typeName, typeConfig] of this._types) {
          const keywords = CATEGORY_KEYWORDS[typeName];
          if (!keywords) continue;

          let score = 0;
          for (const kw of keywords) {
            if (titleLower.includes(kw)) {
              score++;
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestMatch = typeConfig;
          } else if (score === bestScore && score > 0 && typeName === 'debug') {
            // debug wins ties — it's more specific than implementation/explore
            bestMatch = typeConfig;
          } else if (score === bestScore && score > 0 && typeName === 'game-dev' && bestMatch?.name === 'implementation') {
            // game-dev wins ties against implementation — game tasks often contain generic words like "add"
            bestMatch = typeConfig;
          }
        }

        // Fall back to 'general' type if no keyword match
        matched = bestMatch || this._types.get('general') || null;
      }
    }

    if (!matched) return null;

    // Return a copy with effective tools (base + LSP when ready)
    const effectiveTools = this._getEffectiveTools(matched);
    return {
      name: matched.name,
      systemPrompt: matched.systemPrompt,
      allowedTools: effectiveTools,
      timeout: matched.timeout,
      maxConcurrent: matched.maxConcurrent,
    };
  }

  // --- Semaphore ---

  /**
   * Acquire a semaphore slot. Resolves when a slot is available.
   * @returns {Promise<void>}
   */
  async _acquireSlot() {
    if (this._activeCount < this._maxConcurrency) {
      this._activeCount++;
      return;
    }
    // Wait for a slot to open
    return new Promise((resolve) => {
      this._waitQueue.push({ resolve });
    });
  }

  /**
   * Release a semaphore slot. Wakes up the next queued dispatch if any.
   */
  _releaseSlot() {
    // Guard: if cancelAll() zeroed the count while this task's finally{} was
    // still in flight, absorb the release instead of going negative.
    if (this._cancelGeneration > 0) {
      this._cancelGeneration--;
      return;
    }
    if (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift();
      // Don't decrement — the slot transfers to the next waiter
      next.resolve();
    } else {
      this._activeCount--;
    }
  }

  // --- Dispatch (foreground) ---

  /**
   * Dispatch a task to a subagent. Acquires a semaphore slot, runs the agent,
   * and returns the TaskResult.
   * @param {object} task - TaskNode
   * @param {object} context - TaskContext
   * @param {object} [options] - { agentFactory } for DI override
   * @returns {Promise<object>} TaskResult
   */
  async dispatch(task, context, options = {}) {
    // Keyword matching runs first — high-confidence keyword hits override the fast assistant.
    // This prevents the small model from misclassifying tasks that have unambiguous signals
    // (e.g. "debug", "diagnose", "crash") as explore/general.
    const keywordType = this.selectType(task)
    const keywordName = keywordType?.name || 'general'

    // If keyword matching produced a specific (non-general) type, trust it directly.
    // Only fall through to the fast assistant for ambiguous (general) matches.
    let agentType = null
    if (keywordName !== 'general') {
      agentType = keywordType
    } else if (memoryClient && typeof memoryClient.assistRouteTask === 'function') {
      // Ambiguous — ask the fast assistant
      const routed = await memoryClient.assistRouteTask(
        task.title || task.id || '',
        task.description || ''
      )
      if (routed && this._types.has(routed)) {
        agentType = this._types.get(routed)
        const effectiveTools = this._getEffectiveTools(agentType)
        agentType = { ...agentType, allowedTools: effectiveTools }
      }
    }
    if (!agentType) {
      agentType = keywordType || this.selectType(task)
    }

    const profile = this._getCalibrationProfile?.();
    const timeout = agentType?.timeout ?? profile?.poolTimeout ?? this._defaultTimeout;
    const taskId = task.id || crypto.randomUUID();
    const agentTypeName = agentType?.name || 'general';

    // Inject LSP safe-edit instructions when routed to implementation and LSP is ready
    const lspStatus = typeof this._getLspStatus === 'function' ? this._getLspStatus() : null;
    if (agentTypeName === 'implementation' && lspStatus === 'ready' && this._safeEditInstructions) {
      task = { ...task, systemPromptSuffix: this._safeEditInstructions };
    }

    // Emit agent-type-selected immediately so the UI can show which agent
    // is handling this task before the (potentially long) execution starts.
    this.emit('agent-type-selected', { taskId: task.id, agentType: agentTypeName });

    await this._acquireSlot();

    const abortController = new AbortController();
    this._runningTasks.set(taskId, {
      task,
      startTime: Date.now(),
      abortController,
      agentType: agentTypeName,
    });

    try {
      const result = await this._runAgent(task, context, agentType, timeout, abortController, options);
      return result;
    } finally {
      this._runningTasks.delete(taskId);
      this._releaseSlot();
    }
  }

  /**
   * Run an agent with timeout handling.
   */
  async _runAgent(task, context, agentType, timeout, abortController, options = {}) {
    const factory = options.agentFactory || this._agentFactory;
    const startTime = Date.now();

    // Create the agent via factory or default
    const agent = factory
      ? factory(task, agentType, context)
      : this._createDefaultAgent(task, agentType, context);

    // Store agent reference so cancelAll() can call interrupt() on it
    const taskEntry = this._runningTasks.get(task.id || '')
    if (taskEntry) taskEntry.agent = agent

    // Race between agent execution and timeout
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task ${task.id} timed out after ${timeout}ms`));
      }, timeout);

      // Clean up timer if abort is signaled
      abortController.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

      // Store timer ref for cleanup
      abortController._timer = timer;
    });

    try {
      const result = await Promise.race([
        this._executeAgent(agent, task, agentType, startTime),
        timeoutPromise,
      ]);
      // Clear timeout timer
      if (abortController._timer) clearTimeout(abortController._timer);
      return result;
    } catch (err) {
      if (abortController._timer) clearTimeout(abortController._timer);

      // Terminate agent on timeout or error
      if (agent && typeof agent.interrupt === 'function') {
        try { await agent.interrupt(); } catch (_) { /* ignore */ }
      }

      if (err.message && err.message.includes('timed out')) {
        return {
          nodeId: task.id,
          output: '',
          duration: Date.now() - startTime,
          agentType: agentType?.name || 'general',
          error: err.message,
        };
      }
      throw err;
    }
  }

  /**
   * Execute an agent and collect results, forwarding streaming events.
   */
  async _executeAgent(agent, task, agentType, startTime) {
    // If agent is a simple function (mock), call it directly
    if (typeof agent === 'function') {
      const output = await agent();
      return {
        nodeId: task.id,
        output: output || '',
        duration: Date.now() - startTime,
        agentType: agentType?.name || 'general',
      };
    }

    // If agent has a run method (QwenBridge-like)
    if (agent && typeof agent.run === 'function') {
      // Set up event forwarding — keep a reference so we can remove it after run
      let eventHandler = null;
      if (agent.on) {
        eventHandler = (evt) => {
          this.emit('agent-event', {
            taskId: task.id,
            ...evt,
          });
        };
        agent.on('event', eventHandler);
      }

      let result;
      try {
        result = await agent.run({
          prompt: task.title,
          cwd: task.cwd || process.cwd(),
        });
      } finally {
        // Always remove the listener to prevent accumulation across dispatches
        if (eventHandler && agent.off) {
          agent.off('event', eventHandler);
        }
      }

      return {
        nodeId: task.id,
        output: result?.output || result || '',
        duration: Date.now() - startTime,
        agentType: agentType?.name || 'general',
      };
    }

    // If agent is a promise (simplest mock pattern)
    if (agent && typeof agent.then === 'function') {
      const output = await agent;
      return {
        nodeId: task.id,
        output: output || '',
        duration: Date.now() - startTime,
        agentType: agentType?.name || 'general',
      };
    }

    return {
      nodeId: task.id,
      output: '',
      duration: Date.now() - startTime,
      agentType: agentType?.name || 'general',
    };
  }

  /**
   * Default agent creation (placeholder — real impl would use QwenBridge).
   */
  _createDefaultAgent(task, agentType, context) {
    // In production, this would create a QwenBridge with CallbackSink
    return async () => `Executed: ${task.title}`;
  }

  /**
   * Cancel all currently running foreground tasks.
   * Signals each task's AbortController and calls interrupt() on the agent.
   * Used by Orchestrator.abort() to stop all in-flight dispatches immediately.
   */
  async cancelAll() {
    const interruptPromises = []
    for (const [, entry] of this._runningTasks) {
      try { entry.abortController.abort() } catch (_) {}
      if (entry.agent && typeof entry.agent.interrupt === 'function') {
        try { interruptPromises.push(entry.agent.interrupt()) } catch (_) {}
      }
    }
    // Also drain the wait queue so queued dispatches don't start
    for (const waiter of this._waitQueue) {
      try { waiter.resolve() } catch (_) {}
    }
    this._waitQueue.length = 0
    // Reset active count so the next dispatch can acquire a slot immediately.
    // Without this, the slot held by the aborted task stays "occupied" until
    // its finally{} block fires _releaseSlot() — which may happen after the
    // next orchestrator has already tried (and failed) to acquire a slot.
    const prevActive = this._activeCount
    this._runningTasks.clear()
    this._activeCount = 0
    // Patch _releaseSlot for any in-flight finally{} blocks that will fire
    // after we've already zeroed the count — prevent going negative.
    this._cancelGeneration = (this._cancelGeneration || 0) + prevActive
    // Wait for all agents to finish their interrupt (server cleanup)
    // with a timeout so we don't hang forever if an agent is stuck
    if (interruptPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(interruptPromises),
        new Promise(r => setTimeout(r, 10000)),
      ])
    }
  }

  // --- Background Dispatch ---

  /**
   * Dispatch a task to run in the background.
   * Returns the task ID immediately. The task runs asynchronously.
   * @param {object} task - TaskNode
   * @param {object} context - TaskContext
   * @param {object} [options] - { agentFactory } for DI override
   * @returns {Promise<string>} taskId
   */
  async dispatchBackground(task, context, options = {}) {
    const taskId = `bg-${crypto.randomUUID()}`;
    const agentType = this.selectType(task);

    const bgTask = {
      id: taskId,
      taskNode: task,
      status: 'running',
      startTime: Date.now(),
      endTime: undefined,
      output: undefined,
      events: [],
      _abortController: new AbortController(),
    };

    this._backgroundTasks.set(taskId, bgTask);
    this.emit('bg-task-event', { taskId, type: 'started', task });

    // Run in background (don't await)
    this._runBackgroundTask(taskId, task, context, agentType, options).catch((err) => {
      const bt = this._backgroundTasks.get(taskId);
      if (bt && bt.status === 'running') {
        bt.status = 'failed';
        bt.endTime = Date.now();
        bt.output = err.message || String(err);
        this.emit('bg-task-event', { taskId, type: 'failed', error: bt.output });
      }
    });

    return taskId;
  }

  /**
   * Internal: run a background task.
   */
  async _runBackgroundTask(taskId, task, context, agentType, options = {}) {
    const bgTask = this._backgroundTasks.get(taskId);
    if (!bgTask) return;

    const factory = options.agentFactory || this._agentFactory;
    const startTime = bgTask.startTime;

    try {
      const agent = factory
        ? factory(task, agentType, context)
        : this._createDefaultAgent(task, agentType, context);

      // Buffer events
      const eventHandler = (evt) => {
        bgTask.events.push(evt);
        this.emit('bg-task-event', { taskId, type: 'event', event: evt });
      };

      if (agent && typeof agent.on === 'function') {
        agent.on('event', eventHandler);
      }

      let output;
      if (typeof agent === 'function') {
        output = await agent();
      } else if (agent && typeof agent.run === 'function') {
        const result = await agent.run({ prompt: task.title, cwd: task.cwd || process.cwd() });
        output = result?.output || result || '';
      } else if (agent && typeof agent.then === 'function') {
        output = await agent;
      } else {
        output = '';
      }

      // Check if cancelled while running
      if (bgTask.status === 'cancelled') return;

      bgTask.status = 'completed';
      bgTask.endTime = Date.now();
      bgTask.output = output || '';
      this.emit('bg-task-event', { taskId, type: 'completed', output: bgTask.output });
    } catch (err) {
      if (bgTask.status === 'cancelled') return;
      bgTask.status = 'failed';
      bgTask.endTime = Date.now();
      bgTask.output = err.message || String(err);
      this.emit('bg-task-event', { taskId, type: 'failed', error: bgTask.output });
    }
  }

  // --- Cancel ---

  /**
   * Cancel a background task.
   * @param {string} taskId
   */
  async cancel(taskId) {
    const bgTask = this._backgroundTasks.get(taskId);
    if (!bgTask || bgTask.status !== 'running') return;

    bgTask.status = 'cancelled';
    bgTask.endTime = Date.now();

    if (bgTask._abortController) {
      bgTask._abortController.abort();
    }

    this.emit('bg-task-event', { taskId, type: 'cancelled' });
  }

  // --- Query Methods ---

  /**
   * Get all currently running foreground tasks.
   * @returns {object[]}
   */
  getRunningTasks() {
    const result = [];
    for (const [taskId, info] of this._runningTasks) {
      result.push({
        taskId,
        task: info.task,
        startTime: info.startTime,
        agentType: info.agentType,
      });
    }
    return result;
  }

  /**
   * Get all background tasks.
   * @returns {object[]}
   */
  getBackgroundTasks() {
    const result = [];
    for (const [, bt] of this._backgroundTasks) {
      result.push({
        id: bt.id,
        taskNode: bt.taskNode,
        status: bt.status,
        startTime: bt.startTime,
        endTime: bt.endTime,
        output: bt.output,
        events: bt.events,
      });
    }
    return result;
  }

  /**
   * Shut down the agent pool. Cancel all background tasks and release resources.
   */
  async shutdown() {
    // Cancel all running background tasks
    for (const [taskId, bt] of this._backgroundTasks) {
      if (bt.status === 'running') {
        await this.cancel(taskId);
      }
    }

    // Abort all running foreground tasks
    for (const [, info] of this._runningTasks) {
      if (info.abortController) {
        info.abortController.abort();
      }
    }

    // Clear wait queue
    for (const waiter of this._waitQueue) {
      // Reject waiters? No — just resolve them so they can exit gracefully
      waiter.resolve();
    }
    this._waitQueue = [];
    this._activeCount = 0;
  }
}

// --- Exports ---

module.exports = {
  AgentPool,
  CATEGORY_KEYWORDS,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_TIMEOUT,
  LSP_TOOL_SETS,
};
