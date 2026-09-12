export function selectDramartTeamId(describeUserResponse) {
  const result = describeUserResponse?.Result ?? describeUserResponse?.result ?? describeUserResponse ?? {};
  const teams = result?.MemDescription?.Teams ?? result?.memDescription?.teams ?? [];
  const team = teams.find((item) => item?.IsActiveTeam ?? item?.isActiveTeam) ?? teams[0];
  const teamId = team?.TeamID ?? team?.TeamId ?? team?.teamId;
  if (!teamId) throw new Error('当前登录账号没有可用团队');
  return String(teamId);
}

export async function resolveDramartTeamId(page, explicitTeamId = '') {
  const override = String(explicitTeamId || '').trim();
  if (override) return override;
  const describeUserResponse = await page.evaluate(async () => {
    const token = localStorage.getItem('DRAMART_AUTH_TOKEN');
    const refreshToken = localStorage.getItem('DRAMART_REFRESH_TOKEN');
    if (!token) throw new Error('localStorage 中没有 DRAMART_AUTH_TOKEN，请先登录');
    const response = await fetch('/proxy/api/v1/accessa/DescribeUser', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: token,
        'X-Vsd-Auth-Token': token,
        'X-Vsd-Refresh-Token': refreshToken || '',
      },
      body: '{}',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`/proxy/api/v1/accessa/DescribeUser HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
  });
  return selectDramartTeamId(describeUserResponse);
}
