import { describe, expect, it } from 'vitest'
import { demoSkills, splitSkills } from './skills-library'

describe('skills library', () => {
  it('splits shared skills from the ones that belong to one bot', () => {
    const skills = demoSkills()
    expect(splitSkills(skills).shared.map((skill) => skill.name)).toEqual(['mail-approval', 'places'])
    expect(splitSkills(skills).bot.map((skill) => skill.name)).toEqual(['weekly-notes'])
    expect(skills.find((skill) => skill.name === 'places')?.enabled).toBe(false)
  })
})
