import { Client } from 'plivo';
import dotenv from 'dotenv';
dotenv.config();

const handleEmptyEnv = (key: string, value: any) => {
  if (!value) {
    console.error(`${key} is not set`);
    process.exit(1);
  }
};
const PLIVO_AUTH_ID = process.env.PLIVO_AUTH_ID;
handleEmptyEnv(`PLIVO_AUTH_ID`, PLIVO_AUTH_ID);
const PLIVO_AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;
handleEmptyEnv(`PLIVO_AUTH_TOKEN`, PLIVO_AUTH_TOKEN);
const LOCAL_TUNNEL_URL = process.env.LOCAL_TUNNEL_URL;
handleEmptyEnv(`LOCAL_TUNNEL_URL`, LOCAL_TUNNEL_URL);
const PLIVO_NUMBER = process.env.PLIVO_NUMBER;
handleEmptyEnv(`PLIVO_NUMBER`, PLIVO_NUMBER);

const client = new Client(PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN);
const APPLICATION_NAME = `plivo-openai-agents-js-test`;

const updatePhoneNumber = async (phoneNumber: string, appId: string) => {
  try {
    return client.numbers.update(phoneNumber, {
      appId,
      subAccount: '',
      alias: '',
    });
  } catch (error) {
    console.error(
      `error while updating phone number ${phoneNumber} with appId ${appId}`,
    );
    console.error(error);
  }
};
(async () => {
  // create application
  const application = await client.applications.create(APPLICATION_NAME, {
    answerUrl: `${LOCAL_TUNNEL_URL}/client`,
    answerMethod: 'GET',
  });

  // update phone number
  const updatedPhoneNumber = await updatePhoneNumber(
    PLIVO_NUMBER!,
    application.appId,
  );
  if (updatedPhoneNumber && updatedPhoneNumber.message === 'changed') {
    console.log('Setup completed successfully');
  } else {
    console.log('Setup failed');
  }
})();
