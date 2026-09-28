export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const fmt = (match) => `${match.pattern}@${match.index}+${match.length}`;
