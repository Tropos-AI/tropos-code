// src/learning/skill-tracker.ts

/**
 * Which skills the model has seen in this session: loaded with the Skill tool or created with
 * SkillManage. SkillManage refuses to patch a skill the model hasn't read, so an edit is never made
 * blind against instructions it only guessed at. One per session; the integrator resets it on /clear.
 */
export class SkillTracker {
  private readonly viewed = new Set<string>();

  markViewed(name: string): void {
    this.viewed.add(name);
  }

  hasViewed(name: string): boolean {
    return this.viewed.has(name);
  }

  reset(): void {
    this.viewed.clear();
  }
}
