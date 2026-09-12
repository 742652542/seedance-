import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDramartTeamId, selectDramartTeamId } from './dramart-team.js';

test('selects the active team returned by DescribeUser', () => {
  const response = {
    Result: {
      MemDescription: {
        Teams: [
          { TeamID: 'team-old', IsActiveTeam: false },
          { TeamID: 'team-current', IsActiveTeam: true },
        ],
      },
    },
  };

  assert.equal(selectDramartTeamId(response), 'team-current');
});

test('fails clearly when DescribeUser has no usable team', () => {
  assert.throws(() => selectDramartTeamId({ Result: { MemDescription: { Teams: [] } } }), /团队/);
});

test('explicit TEAM_ID override does not request DescribeUser', async () => {
  let evaluated = false;
  const page = { evaluate: async () => { evaluated = true; } };

  assert.equal(await resolveDramartTeamId(page, 'team-override'), 'team-override');
  assert.equal(evaluated, false);
});

test('resolves the current team from the authenticated page', async () => {
  const page = {
    evaluate: async () => ({
      Result: {
        MemDescription: {
          Teams: [{ TeamID: 'team-current', IsActiveTeam: true }],
        },
      },
    }),
  };

  assert.equal(await resolveDramartTeamId(page), 'team-current');
});
