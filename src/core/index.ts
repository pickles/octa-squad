// Public surface of the engine-independent core.
export * from './data';
export * from './ecs';
export * from './map';
export * from './missions';
export * from './commands';
export { Sim, TICK, SIM_VERSION, verifyReplay } from './sim';
export type { Replay, SimOptions, Cloud, Mine, Shell, Charge, Projectile, Zone, Fx, LogEntry, Outcome, Alert } from './sim';
export { AgentPort, buildLoadout, rulesText } from './agent';
export type { Action, ActResult, Observation } from './agent';
export { brainTick } from './brain';
export { blankScenario, validateScenario, missionFromScenario, registerScenario, unregisterScenario, customMissions, findMission, VICTORY_NAMES } from './scenario';
export type { ScenarioDef, ScenarioGroup, VictoryKind, StructType, Area } from './scenario';
