export const code = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

export const grab = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};
