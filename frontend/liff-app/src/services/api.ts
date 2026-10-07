// Backend API calls (API Gateway) will live here once AWS is set up.
export type ReportFormData = {
  image: File;
  description: string;
};

// Placeholder until API Gateway + Lambda exist: pretends to send the report
export async function submitReport(data: ReportFormData): Promise<void> {
  console.info('submitReport (stub', {
    description: data.description,
    imageName: data.image.name,
    imageSize: data.image.size,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000)); // Fake delay 1 sec to "Submitting..." state
}
