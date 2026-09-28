export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const texts = (result) => result.lines.map((line) => line.text);
