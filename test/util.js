export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret',
  region: 'cn-north-1',
  service: 'demo',
};

export const request = {
  method: 'post',
  path: '/v1/items/中文 name',
  query: { b: '2', a: ['1', '3'], empty: '', star: '*' },
  headers: {
    Host: 'api.example.com',
    'Content-Type': 'text/plain; charset=utf-8',
    Authorization: 'ignored',
    'X-Trace': ['t2', 't1'],
  },
  payload: 'hello',
  credentials,
  timestamp: '2013-05-24T00:00:00Z',
};
